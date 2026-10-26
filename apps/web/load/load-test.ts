import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { defaultSelection, type ConfiguredProduct } from "@ssc/domain";
import { createDb, sql, type Database } from "@ssc/db";
import { runMigrations } from "@ssc/db/maintenance";
import { seedDemoData } from "@ssc/db/seed";
import { loadRootEnv } from "@ssc/env";
import Stripe from "stripe";

/*
 * LOAD TEST — order placement and payment webhooks against a local production build.
 *
 * Starts `next start` on a dedicated database (DATABASE_URL_LOAD, reset to the demo seed), then:
 *  1. rush       — many guests quote, place, open checkout and pay at once, spread over the slots;
 *  2. one slot   — more guests than the slot holds aim at the same pickup time simultaneously;
 *  3. retries    — each checkout is submitted three times at once (double taps, flaky networks);
 *  4. webhooks   — signed provider events, each delivered three times concurrently.
 * Afterwards the database is checked: no slot over capacity, one order per idempotency key, every
 * approved payment recorded, each webhook event stored once. Fails on any 5xx, network error,
 * broken invariant or latency budget. Payments use the development simulator; webhook events
 * name sessions this app never created, so nothing is fetched from Stripe.
 *
 * Usage (from apps/web, after `npx next build`): npm run test:load
 * Tunables: LOAD_CUSTOMERS (300), LOAD_CONCURRENCY (30), LOAD_WEBHOOKS (200), LOAD_PORT (3200).
 */

const CUSTOMERS = Number(process.env.LOAD_CUSTOMERS ?? 300);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 30);
const WEBHOOK_EVENTS = Number(process.env.LOAD_WEBHOOKS ?? 200);
const PORT = Number(process.env.LOAD_PORT ?? 3200);
const BASE_URL = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = "whsec_loadtestonly";

/**
 * p95 budgets (ms) per scenario and step, at the default concurrency on a developer machine;
 * production (pooled Neon) should do better. The burst scenarios check correctness only: their
 * requests queue on one slot lock or arrive all at once by design.
 */
const BUDGETS: Record<string, number> = {
  "rush quote": 500,
  "rush place": 1000,
  "rush checkout": 500,
  "rush pay": 1000,
  "webhooks webhook": 300,
};

// --- Measurements ------------------------------------------------------------------------------

/** The scenario running now; every sample is reported under it. */
let scenario = "setup";

interface Sample {
  scenario: string;
  step: string;
  ms: number;
  status: number;
  reason?: string;
}

const samples: Sample[] = [];
const failures: string[] = [];

interface CallResult<T> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  step: string,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<CallResult<T>> {
  const started = performance.now();
  let status = 0;
  let body: unknown = null;
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: { "content-type": "application/json", ...init.headers },
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch (error) {
    failures.push(`${step}: network error ${String(error)}`);
  }
  const reason = (body as { reason?: string } | null)?.reason;
  samples.push({
    scenario,
    step,
    ms: performance.now() - started,
    status,
    ...(reason ? { reason } : {}),
  });
  if (status >= 500) failures.push(`${step}: HTTP ${status} on ${path}`);
  return { status, body: body as T };
}

/** Runs `task` for each item with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++]!);
    }),
  );
}

/** Each simulated customer comes from its own address, as real guests would. */
const customerHeaders = (n: number) => ({
  "x-forwarded-for": `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
});

// --- The customer journey ------------------------------------------------------------------------

type Line = {
  lineId: string;
  productId: string;
  variantId: string;
  optionIds: string[];
  quantity: number;
};

interface Placed {
  orderId: string;
  guestToken: string | null;
  replayed: boolean;
}

/** Quote → place → open checkout → pay. Returns the order when one was created. */
async function journey(
  n: number,
  lines: Line[],
  slot: string,
  copies = 1,
): Promise<{ placed: Placed | null; paid: boolean; refused?: string }> {
  const headers = customerHeaders(n);
  const quote = await call<{ quote: { totalCents: number } }>("quote", "/api/v1/cart/quote", {
    method: "POST",
    headers,
    body: JSON.stringify({ lines, pickupAt: slot, fulfilment: { method: "pickup" } }),
  });
  if (quote.status !== 200) return { placed: null, paid: false, refused: `quote ${quote.status}` };

  const order = JSON.stringify({
    idempotencyKey: randomUUID(),
    lines,
    fulfilment: { method: "pickup", when: { kind: "scheduled", at: slot } },
    contact: { name: `Load ${n}`, email: `load-${n}@example.test` },
    expectedTotalCents: quote.body.quote.totalCents,
    locale: "fr-CA",
  });
  // Identical submissions at once: exactly one may create the order.
  const attempts = await Promise.all(
    Array.from({ length: copies }, () =>
      call<Placed & { reason?: string }>("place", "/api/v1/orders", {
        method: "POST",
        headers,
        body: order,
      }),
    ),
  );
  const created = attempts.filter((a) => a.status === 201);
  const ok = attempts.filter((a) => a.status === 200 || a.status === 201);
  if (created.length > 1)
    failures.push(`place: one idempotency key created ${created.length} orders`);
  if (new Set(ok.map((a) => a.body.orderId)).size > 1)
    failures.push("place: replays of one key returned different orders");
  const winner = created[0] ?? ok[0];
  if (!winner) {
    const refused = attempts.find((a) => a.status === 422)?.body.reason;
    if (!refused)
      failures.push(`place: unexpected statuses ${attempts.map((a) => a.status).join(",")}`);
    return { placed: null, paid: false, refused: refused ?? "error" };
  }

  const placed = winner.body;
  const tokenHeaders = { ...headers, "x-order-token": placed.guestToken ?? "" };
  const checkout = await call("checkout", `/api/v1/orders/${placed.orderId}/checkout`, {
    method: "POST",
    headers: tokenHeaders,
    body: JSON.stringify({ locale: "fr" }),
  });
  if (checkout.status !== 200) failures.push(`checkout: HTTP ${checkout.status}`);
  const pay = await call<{ status?: string }>("pay", "/api/dev/fake-payments", {
    method: "POST",
    headers: tokenHeaders,
    body: JSON.stringify({ orderId: placed.orderId, outcome: "approve", locale: "fr" }),
  });
  if (pay.status !== 200) failures.push(`pay: HTTP ${pay.status}`);
  return { placed, paid: pay.status === 200 };
}

// --- Setup ------------------------------------------------------------------------------------

async function resetDatabase(url: string) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/^\w+$/.test(name) || !name.includes("load"))
    throw new Error("DATABASE_URL_LOAD must name a database containing 'load' (it is wiped)");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = createDb(admin.toString(), { max: 1 });
  try {
    const exists = await server.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (exists.length === 0) await server.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await server.close();
  }
  const { db, close } = createDb(url, { max: 1 });
  try {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await runMigrations(db);
    await seedDemoData(db);
  } finally {
    await close();
  }
}

const healthy = () =>
  fetch(`${BASE_URL}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

async function startServer(url: string): Promise<ChildProcess> {
  // Measuring some other server (e.g. one left over from an aborted run) would be meaningless.
  if (await healthy()) throw new Error(`Port ${PORT} is already in use; stop that server first`);
  // Next's own entry point, without a shell, so killing this process stops the server itself.
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    // Errors only: stdout is the development email printout for every order.
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: url,
      BETTER_AUTH_URL: BASE_URL,
      EMAIL_TRANSPORT: "console",
      PAYMENT_PROVIDER: "fake",
      // Only so the webhook route verifies signatures; no Stripe call is made (unknown sessions).
      STRIPE_SECRET_KEY: "sk_test_loadtestonly",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await healthy()) return server;
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  server.kill();
  throw new Error(`Server did not become healthy on ${BASE_URL} (did you run \`next build\`?)`);
}

// --- Checks and report ------------------------------------------------------------------------

async function verify(db: Database, expected: { orders: number; paid: number; events: number }) {
  const [over] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select slot_start from orders
      where status in ('paid', 'accepted', 'in_preparation', 'ready', 'awaiting_payment')
        and slot_start is not null
      group by slot_start
      having count(*) > (select max_orders_per_slot from store_settings where id = 1)
    ) s`);
  if ((over?.n ?? 0) > 0)
    failures.push(`capacity: ${over!.n} slot(s) hold more orders than allowed`);

  const [orders] = await db.execute<{ n: number; paid: number }>(sql`
    select count(*)::int as n, count(*) filter (where status = 'paid')::int as paid
    from orders where guest_email like 'load-%@example.test'`);
  if (orders?.n !== expected.orders)
    failures.push(`orders: ${orders?.n} in the database, ${expected.orders} created over HTTP`);
  if (orders?.paid !== expected.paid)
    failures.push(`payments: ${orders?.paid} paid orders, ${expected.paid} approvals succeeded`);

  const [events] = await db.execute<{ n: number; processed: number }>(sql`
    select count(*)::int as n, count(processed_at)::int as processed
    from payment_events where event_id like 'evt_load_%'`);
  const stored = events?.n ?? 0;
  const processed = events?.processed ?? 0;
  if (stored !== expected.events || processed !== expected.events)
    failures.push(
      `webhooks: ${stored} stored / ${processed} processed, expected ${expected.events}`,
    );
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

function report(wallSeconds: number) {
  const groups = [...new Set(samples.map((s) => `${s.scenario} ${s.step}`))];
  const rows = groups.map((group) => {
    const mine = samples.filter((s) => `${s.scenario} ${s.step}` === group);
    const ms = mine.map((s) => s.ms).sort((a, b) => a - b);
    const statuses = Object.entries(
      mine.reduce<Record<string, number>>((acc, s) => {
        const key = s.reason ? `${s.status} ${s.reason}` : String(s.status);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([k, v]) => `${k}×${v}`)
      .join(" ");
    const p95 = percentile(ms, 95);
    const budget = BUDGETS[group];
    if (budget && p95 > budget)
      failures.push(`${group}: p95 ${p95.toFixed(0)} ms over ${budget} ms`);
    return {
      step: group,
      requests: mine.length,
      p50: Math.round(percentile(ms, 50)),
      p95: Math.round(p95),
      p99: Math.round(percentile(ms, 99)),
      max: Math.round(ms.at(-1) ?? 0),
      budget: budget ? `≤${budget}` : "",
      statuses,
    };
  });
  console.table(rows);
  console.log(
    `${samples.length} requests in ${wallSeconds.toFixed(1)} s (${(samples.length / wallSeconds).toFixed(0)} req/s), concurrency ${CONCURRENCY}`,
  );
}

// --- Main -------------------------------------------------------------------------------------

async function main() {
  loadRootEnv();
  const url = process.env.DATABASE_URL_LOAD;
  if (!url) throw new Error("DATABASE_URL_LOAD is required (see .env.example)");
  await resetDatabase(url);
  const server = await startServer(url);
  const { db, close } = createDb(url, { max: 2 });
  const started = performance.now();
  try {
    // A realistic basket: the default drink of each of the first two products.
    const menu = (
      await call<{ categories: Array<{ products: Array<{ slug: string }> }> }>(
        "menu",
        "/api/v1/menu",
      )
    ).body;
    const slugs = menu.categories.flatMap((c) => c.products.map((p) => p.slug)).slice(0, 2);
    const lines: Line[] = [];
    for (const [i, slug] of slugs.entries()) {
      const product = (await call<ConfiguredProduct>("product", `/api/v1/products/${slug}`)).body;
      lines.push({
        lineId: `l${i}`,
        productId: product.id,
        quantity: 1,
        ...defaultSelection(product),
      });
    }
    const fulfilment = await call<{
      pickup: { slots: Array<{ startsAt: string; remaining: number }> };
    }>("fulfilment", "/api/v1/store/fulfilment");
    const slots = fulfilment.body.pickup.slots.map((s) => s.startsAt);
    const capacity = fulfilment.body.pickup.slots[0]?.remaining ?? 0;
    if (slots.length < 3) throw new Error("Not enough pickup slots offered to run the test");
    // The last slot is kept for the one-slot scenario.
    const hotSlot = slots.pop()!;

    let customer = 0;
    let created = 0;
    let paid = 0;
    const tally = (r: { placed: Placed | null; paid: boolean }) => {
      if (r.placed && !r.placed.replayed) created++;
      if (r.paid) paid++;
    };

    // 1. Rush: guests spread over the slots, as many at once as CONCURRENCY allows.
    scenario = "rush";
    console.log(`rush: ${CUSTOMERS} guests over ${slots.length} slots…`);
    await pool(
      Array.from({ length: CUSTOMERS }, (_, i) => i),
      CONCURRENCY,
      async (i) => {
        tally(await journey(++customer, lines, slots[i % slots.length]!));
      },
    );

    // 2. One slot: three times its capacity, all at the same instant.
    scenario = "one-slot";
    console.log(`one slot: ${capacity * 3} guests for ${capacity} places…`);
    const contenders = await Promise.all(
      Array.from({ length: capacity * 3 }, () => journey(++customer, lines, hotSlot)),
    );
    contenders.forEach(tally);
    const won = contenders.filter((r) => r.placed).length;
    if (won !== capacity) failures.push(`one slot: ${won} orders for a slot of ${capacity}`);
    // Losers hear "full" (lost the race under the lock) or "unavailable" (full slots aren't offered).
    const taken = contenders.filter(
      (r) => r.refused === "slot_full" || r.refused === "slot_unavailable",
    ).length;
    if (won + taken !== contenders.length)
      failures.push("one slot: a guest was refused for a reason other than the slot being taken");

    // 3. Retries: each checkout submitted three times at once (CONCURRENCY requests in flight).
    scenario = "retries";
    const retryCount = Math.min(50, slots.length);
    console.log(`retries: ${retryCount} checkouts × 3 identical submissions…`);
    await pool(
      Array.from({ length: retryCount }, (_, i) => i),
      Math.max(1, Math.floor(CONCURRENCY / 3)),
      async (i) => {
        tally(await journey(++customer, lines, slots[i]!, 3));
      },
    );

    // 4. Webhooks: each event delivered three times, concurrently (provider retries, backlog).
    scenario = "webhooks";
    console.log(`webhooks: ${WEBHOOK_EVENTS} events × 3 deliveries…`);
    const signer = new Stripe("sk_test_loadtestonly");
    const deliveries = Array.from({ length: WEBHOOK_EVENTS }, (_, i) => {
      const payload = JSON.stringify({
        id: `evt_load_${i}`,
        object: "event",
        type: "checkout.session.completed",
        data: { object: { id: `cs_load_${i}`, object: "checkout.session" } },
      });
      return { payload, copies: 3 };
    }).flatMap(({ payload, copies }) => Array.from({ length: copies }, () => payload));
    await pool(deliveries, CONCURRENCY, async (payload) => {
      const signature = signer.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
      });
      const res = await call("webhook", "/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      });
      if (res.status !== 200) failures.push(`webhook: HTTP ${res.status}`);
    });

    report((performance.now() - started) / 1000);
    await verify(db, { orders: created, paid, events: WEBHOOK_EVENTS });
  } finally {
    await close();
    server.kill();
  }

  if (failures.length) {
    const unique = [...new Set(failures)];
    console.error(`\n✖ ${failures.length} problem(s):\n  ${unique.slice(0, 30).join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✔ no errors, invariants hold, within budgets");
  }
}

await main();
