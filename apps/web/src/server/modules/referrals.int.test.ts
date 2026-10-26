import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  eq,
  loyaltyAccounts,
  loyaltyTransactions,
  orders,
  referrals,
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
import { getProductBySlug } from "./catalog/storefront";
import { provisionAccount } from "./identity/provisioning";
import { currentRules, programInput, saveProgramVersion } from "./loyalty/program";
import { enterReferralCode, getMyReferral } from "./loyalty/referrals";
import { quoteCart } from "./ordering/cart-quote";
import { transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";

/*
 * Referral program (D17): off by default; when on, a newcomer's first qualifying completed order
 * gives stamps to both sides, once, within the anti-abuse limits.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const DAY = 86_400_000;

let handle: DbHandle;
let db: Database;
let staff: Actor;
let owner: Actor;
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
  owner = { userId: (await byEmail("owner")).id, role: "owner" };
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

async function setRules(overrides: Record<string, unknown>) {
  const current = await currentRules(db);
  await saveProgramVersion(db, owner, {
    ...Object.fromEntries(
      Object.keys(programInput.shape).map((k) => [k, current[k as keyof typeof current]]),
    ),
    note: "test change",
    ...overrides,
  });
}

async function customer(createdDaysAgo = 0): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    name: "",
    email: `${userId}@example.test`,
    createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY),
  });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}

/** Large lattes (2,00 $ each before tax), paid; completed unless told otherwise. */
async function buy(actor: Actor, quantity: number, complete = true) {
  const lines = [
    {
      lineId: "l1",
      productId: latte.id,
      variantId: latte.variants[1]!.id,
      optionIds: latte.groups
        .flatMap((g) => g.options)
        .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
        .map((o) => o.id),
      quantity,
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
      contact: { name: "Robin" },
      expectedTotalCents: quote.totalCents,
      locale: "fr-CA",
    },
    { provider: "fake", now: NOW },
  );
  await simulateFakePayment(db, placed.orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: actor.userId,
    now: NOW,
  });
  if (complete) {
    const flow = ["accepted", "in_preparation", "ready", "completed"];
    const row = async () =>
      (await db.select().from(orders).where(eq(orders.id, placed.orderId)))[0]!;
    for (const to of flow.slice(flow.indexOf((await row()).status) + 1))
      await transitionOrderAsStaff(
        db,
        staff,
        placed.orderId,
        { to, expectedVersion: (await row()).version },
        NOW,
      );
  }
  return placed.orderId;
}

async function lifetime(actor: Actor) {
  const [row] = await db
    .select({ n: loyaltyAccounts.lifetimeStamps })
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.userId, actor.userId));
  return row!.n;
}

async function referralEntries(actor: Actor) {
  const [account] = await db
    .select()
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.userId, actor.userId));
  return (
    await db
      .select()
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.accountId, account!.id))
  ).filter((e) => (e.details as { referral?: string }).referral);
}

/** An existing customer with a paid order, and their code. */
async function referrer() {
  const actor = await customer(60);
  await buy(actor, 1);
  const { code } = await getMyReferral(db, actor, NOW);
  return { actor, code: code! };
}

describe("referral program", () => {
  it("is off until the owner turns it on", async () => {
    const someone = await customer();
    expect(await getMyReferral(db, someone, NOW)).toMatchObject({
      enabled: false,
      code: null,
      canEnterCode: false,
    });
    expect(await failure(enterReferralCode(db, someone, { code: "ABCDEFG" }, NOW))).toBe(
      "referrals_off",
    );
  });

  it("rewards both sides once, when the newcomer's first qualifying order is completed", async () => {
    await setRules({ referralEnabled: true });
    const { actor: sam, code } = await referrer();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
    // The same code every time.
    expect((await getMyReferral(db, sam, NOW)).code).toBe(code);

    const robin = await customer();
    expect((await getMyReferral(db, robin, NOW)).canEnterCode).toBe(true);
    await enterReferralCode(db, robin, { code: code.toLowerCase() }, NOW);
    expect(await getMyReferral(db, robin, NOW)).toMatchObject({
      referredStatus: "pending",
      canEnterCode: false,
    });

    const samBefore = await lifetime(sam);
    // 3 lattes: 6,00 $ before tax, above the 5,00 $ minimum.
    await buy(robin, 3);
    expect(await lifetime(robin)).toBe(3 + 1); // three drinks + one welcome stamp
    expect(await lifetime(sam)).toBe(samBefore + 2);
    expect((await referralEntries(robin)).map((e) => e.stamps)).toEqual([1]);
    expect((await referralEntries(sam)).map((e) => e.stamps)).toEqual([2]);
    expect(await getMyReferral(db, sam, NOW)).toMatchObject({ rewardedReferrals: 1 });

    // Later orders give nothing more.
    await buy(robin, 3);
    expect((await referralEntries(sam)).map((e) => e.stamps)).toEqual([2]);
  });

  it("waits for an order above the minimum, and for completion (not just payment)", async () => {
    await setRules({ referralEnabled: true });
    const { actor: sam, code } = await referrer();
    const robin = await customer();
    await enterReferralCode(db, robin, { code }, NOW);
    await buy(robin, 1); // 2,00 $: below the minimum
    await buy(robin, 3, false); // paid, still in the kitchen
    expect(await referralEntries(sam)).toEqual([]);
    const [row] = await db
      .select()
      .from(referrals)
      .where(eq(referrals.refereeUserId, robin.userId));
    expect(row!.status).toBe("pending");
  });

  it("refuses its own code, a second code, older or active customers, inactive referrers", async () => {
    await setRules({ referralEnabled: true });
    const { actor: sam, code } = await referrer();
    expect(await failure(enterReferralCode(db, sam, { code }, NOW))).toBe("own_code");
    expect(await failure(enterReferralCode(db, await customer(), { code: "ZZZZZZZ" }, NOW))).toBe(
      "not_found",
    );

    const robin = await customer();
    await enterReferralCode(db, robin, { code }, NOW);
    expect(await failure(enterReferralCode(db, robin, { code }, NOW))).toBe("already_referred");

    expect(await failure(enterReferralCode(db, await customer(45), { code }, NOW))).toBe(
      "not_new_customer",
    );
    const regular = await customer();
    await buy(regular, 1);
    expect(await failure(enterReferralCode(db, regular, { code }, NOW))).toBe("not_new_customer");

    const idle = await customer(60);
    const idleCode = (await getMyReferral(db, idle, NOW)).code!;
    expect(await failure(enterReferralCode(db, await customer(), { code: idleCode }, NOW))).toBe(
      "referrer_inactive",
    );
  });

  it("caps the rewards one referrer can earn in 30 days", async () => {
    await setRules({ referralEnabled: true, referralMonthlyCap: 1 });
    const { actor: sam, code } = await referrer();
    const first = await customer();
    const second = await customer();
    await enterReferralCode(db, first, { code }, NOW);
    await enterReferralCode(db, second, { code }, NOW);
    await buy(first, 3);
    await buy(second, 3);
    expect((await referralEntries(sam)).map((e) => e.stamps)).toEqual([2]);
    const [declined] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.refereeUserId, second.userId)));
    expect(declined).toMatchObject({ status: "declined", reason: "monthly_cap" });
    // The newcomer whose referral was declined gets no welcome stamp either.
    expect(await referralEntries(second)).toEqual([]);
  });
});
