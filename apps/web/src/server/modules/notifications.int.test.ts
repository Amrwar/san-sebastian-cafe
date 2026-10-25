import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  eq,
  notificationPreferences,
  orders,
  outboxMessages,
  pushSubscriptions,
  sql,
  users,
  type CatalogProduct,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import {
  MAX_ATTEMPTS,
  processOutbox,
  type Deliverer,
  type QueuedMessage,
} from "../notifications/outbox";
import { removePushSubscription, savePushSubscription } from "../notifications/push-subscriptions";
import { getProductBySlug } from "./catalog/storefront";
import { provisionAccount } from "./identity/provisioning";
import { quoteCart } from "./ordering/cart-quote";
import { refundOrderAsStaff, transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";
import { deleteOwnAccount } from "./privacy/deletion";

/*
 * Customer notifications: queued with the change that causes them (once per event and channel),
 * then sent by the outbox worker with retries.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const MINUTE = 60_000;

let handle: DbHandle;
let db: Database;
let staff: Actor;
let lead: Actor;
let latte: CatalogProduct;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs, outbox_messages restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

async function newCustomer() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await db.insert(users).values({ id: userId, name: "Robin", email });
  await provisionAccount(db, userId, "en-CA");
  return { actor: { userId, role: "customer" } as Actor, email };
}

async function order(actor: Actor | null, { pay = true, email = "guest@example.test" } = {}) {
  const lines = [
    {
      lineId: "l1",
      productId: latte.id,
      variantId: latte.variants[1]!.id,
      optionIds: latte.groups
        .flatMap((g) => g.options)
        .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
        .map((o) => o.id),
      quantity: 1,
    },
  ];
  const { quote } = await quoteCart(db, actor, { lines }, NOW);
  const placed = await placeOrder(
    db,
    actor,
    {
      idempotencyKey: randomUUID(),
      lines,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Robin", email: actor ? undefined : email },
      expectedTotalCents: quote.totalCents,
      locale: actor ? "en-CA" : "fr-CA",
    },
    { provider: "fake", now: NOW },
  );
  if (pay) await payFor(placed.orderId, actor);
  return placed.orderId;
}

const payFor = (orderId: string, actor: Actor | null) =>
  simulateFakePayment(db, orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: actor?.userId ?? null,
    now: NOW,
  });

async function advance(orderId: string, ...steps: string[]) {
  for (const to of steps) {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    await transitionOrderAsStaff(
      db,
      to === "cancelled" ? lead : staff,
      orderId,
      {
        to,
        expectedVersion: row!.version,
        ...(to === "cancelled" ? { reason: "Machine en panne" } : {}),
      },
      NOW,
    );
  }
}

const queued = () =>
  db
    .select()
    .from(outboxMessages)
    .orderBy(outboxMessages.createdAt, outboxMessages.template, outboxMessages.channel);

/** Records what it was asked to send; can be told to fail. */
function recorder(fail: (m: QueuedMessage) => boolean = () => false) {
  const sent: QueuedMessage[] = [];
  const deliverer: Deliverer = {
    send(m) {
      if (fail(m)) return Promise.reject(new Error("smtp down"));
      sent.push(m);
      return Promise.resolve("sent");
    },
  };
  return { sent, deliverer };
}

async function addDevice(actor: Actor, endpoint = `https://push.example.test/${randomUUID()}`) {
  await savePushSubscription(
    db,
    actor,
    { endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } },
    "Test browser",
  );
  return endpoint;
}

describe("queueing", () => {
  it("queues one email per event (confirmation, ready); a repeated payment queues nothing", async () => {
    const { actor, email } = await newCustomer();
    const id = await order(actor);
    // A second payment for the same order is refused, and queues nothing.
    expect(await failure(payFor(id, actor))).toBe("not_awaiting_payment");
    await advance(id, "accepted", "in_preparation", "ready", "completed");
    const rows = await queued();
    expect(rows.map((r) => [r.template, r.channel, r.recipient, r.locale])).toEqual([
      ["order_confirmed", "email", email, "en"],
      ["order_ready", "email", email, "en"],
    ]);
    expect(rows[0]!.payload).toMatchObject({ orderId: id, hasAccount: true, totalCents: 230 });
  });

  it("adds a push for what needs attention, only to customers with a device", async () => {
    const { actor } = await newCustomer();
    await addDevice(actor);
    const id = await order(actor);
    await advance(id, "accepted", "in_preparation", "ready");
    expect((await queued()).map((r) => [r.template, r.channel])).toEqual([
      ["order_confirmed", "email"],
      ["order_ready", "email"],
      ["order_ready", "push"],
    ]);
  });

  it("emails guests at their order address, and respects a customer who turned emails off", async () => {
    const guestOrder = await order(null, { email: "walk.in@example.test" });
    const { actor } = await newCustomer();
    await db
      .insert(notificationPreferences)
      .values({ userId: actor.userId, channel: "email", topic: "order_updates", enabled: false })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.channel,
          notificationPreferences.topic,
        ],
        set: { enabled: false },
      });
    await order(actor);
    const rows = await queued();
    expect(rows.map((r) => [r.recipient, r.locale])).toEqual([["walk.in@example.test", "fr"]]);
    expect(rows[0]!.payload).toMatchObject({ orderId: guestOrder, hasAccount: false });
  });

  it("announces a cancellation with its refund once, and each later partial refund", async () => {
    const { actor } = await newCustomer();
    const cancelled = await order(actor);
    await advance(cancelled, "accepted", "cancelled");
    // The automatic refund settles: no second message about the same money.
    const cancelMessages = (await queued()).filter((r) => r.orderId === cancelled);
    expect(cancelMessages.map((r) => r.template)).toEqual(["order_confirmed", "order_cancelled"]);
    expect(cancelMessages[1]!.payload).toMatchObject({ reason: "Machine en panne", paid: true });

    const served = await order(actor);
    await advance(served, "accepted", "in_preparation", "ready", "completed");
    for (const amount of [50, 30])
      await refundOrderAsStaff(
        db,
        lead,
        served,
        { amountCents: amount, reason: "Trop froid" },
        NOW,
      );
    const refunds = (await queued()).filter((r) => r.template === "order_refunded");
    expect(refunds.map((r) => (r.payload as { refundedCents: number }).refundedCents)).toEqual([
      50, 80,
    ]);
  });

  it("sends nothing for an order that is never paid", async () => {
    await order(null, { pay: false });
    expect(await queued()).toEqual([]);
  });
});

describe("sending", () => {
  it("sends each message once, even with two workers at the same time", async () => {
    const { actor } = await newCustomer();
    for (let i = 0; i < 3; i++) await order(actor);
    const a = recorder();
    const b = recorder();
    const [runA, runB] = await Promise.all([
      processOutbox(db, a.deliverer, { now: NOW }),
      processOutbox(db, b.deliverer, { now: NOW }),
    ]);
    expect(runA.sent + runB.sent).toBe(3);
    expect([...a.sent, ...b.sent].map((m) => m.id).sort()).toEqual(
      (await queued()).map((r) => r.id).sort(),
    );
    expect((await queued()).every((r) => r.status === "sent" && r.sentAt !== null)).toBe(true);
    // Nothing left to send.
    expect(await processOutbox(db, a.deliverer, { now: NOW })).toEqual({
      sent: 0,
      skipped: 0,
      retried: 0,
      failed: 0,
    });
  });

  it("retries with growing delays, then gives up", async () => {
    const { actor } = await newCustomer();
    await order(actor);
    const down = recorder(() => true);
    let now = NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Not due yet: nothing happens.
      if (attempt > 1)
        expect(
          (await processOutbox(db, down.deliverer, { now: new Date(now.getTime() - 1) })).retried,
        ).toBe(0);
      const run = await processOutbox(db, down.deliverer, { now });
      const [row] = await queued();
      expect(row!.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(run.retried).toBe(1);
        expect(row!.status).toBe("pending");
        expect(row!.lastError).toBe("smtp down");
        now = row!.nextAttemptAt;
      } else {
        expect(run.failed).toBe(1);
        expect(row!.status).toBe("failed");
      }
    }
    // The delays grow: 1, 5, 25, 125 minutes.
    expect((now.getTime() - NOW.getTime()) / MINUTE).toBe(1 + 5 + 25 + 125);
  });

  it("takes over a message whose worker stopped mid-way", async () => {
    const { actor } = await newCustomer();
    await order(actor);
    await db
      .update(outboxMessages)
      .set({ status: "sending", lockedUntil: new Date(NOW.getTime() + MINUTE) });
    const ok = recorder();
    expect((await processOutbox(db, ok.deliverer, { now: NOW })).sent).toBe(0);
    expect(
      (await processOutbox(db, ok.deliverer, { now: new Date(NOW.getTime() + 2 * MINUTE) })).sent,
    ).toBe(1);
  });

  it("forgets the account's messages when it is deleted", async () => {
    const { actor, email } = await newCustomer();
    const id = await order(actor);
    await advance(id, "accepted", "in_preparation", "ready", "completed");
    await deleteOwnAccount(db, actor, { confirmEmail: email }, NOW);
    expect(await queued()).toEqual([]);
  });
});

describe("push devices", () => {
  it("are saved per account, moved when another account signs in, and removed on request", async () => {
    const first = await newCustomer();
    const second = await newCustomer();
    const endpoint = await addDevice(first.actor);
    await addDevice(second.actor, endpoint);
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(second.actor.userId);
    // Only the owner can remove it.
    await removePushSubscription(db, first.actor, { endpoint });
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
    await removePushSubscription(db, second.actor, { endpoint });
    expect(
      await db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, endpoint))),
    ).toEqual([]);
  });

  it("refuses insecure endpoints and anonymous callers", async () => {
    const { actor } = await newCustomer();
    expect(
      await failure(
        savePushSubscription(
          db,
          actor,
          {
            endpoint: "http://push.example.test/x",
            keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
          },
          null,
        ),
      ),
    ).toBe("validation_failed");
    expect(await failure(savePushSubscription(db, null, {}, null))).toBe("unauthenticated");
  });
});
