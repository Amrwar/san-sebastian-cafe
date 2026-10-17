import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asc,
  auditEvents,
  eq,
  loyaltyAccounts,
  loyaltyInStoreVisits,
  loyaltyTransactions,
  orderItems,
  orders,
  rewardRedemptions,
  rewards,
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
import { issueCardCode } from "./loyalty/card-code";
import type { LedgerDetails } from "./loyalty/details";
import { lookupCardCode, recordInStoreVisit, voidInStoreVisit } from "./loyalty/in-store";
import { currentRules, programInput, saveProgramVersion } from "./loyalty/program";
import { adjustLoyalty, findLoyaltyCustomer, getCustomerLoyalty } from "./loyalty/staff";
import { getLoyaltySummary } from "./loyalty/summary";
import { quoteCart } from "./ordering/cart-quote";
import { refundOrderAsStaff, transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";

/*
 * The loyalty engine through the real order, payment and refund paths: earning, conversion,
 * reversal policies, reward reinstatement, program versions and the ledger's invariants.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const opts = { provider: "fake" as const, now: NOW };

let handle: DbHandle;
let db: Database;
let customer: Actor;
let staff: Actor;
let lead: Actor;
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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  customer = { userId: (await byEmail("customer")).id, role: "customer" };
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  owner = { userId: (await byEmail("owner")).id, role: "owner" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

const opt = (p: CatalogProduct, nameEn: string) =>
  p.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
const lattes = (quantity: number) => [
  {
    lineId: "l1",
    productId: latte.id,
    variantId: latte.variants[1]!.id, // Large 2,00 $
    optionIds: [opt(latte, "Hot"), opt(latte, "Whole milk")],
    quantity,
  },
];

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

async function newCustomer(): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "", email: `${userId}@example.test` });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}

/** Places and pays an order of large lattes (a $0 order is confirmed without payment). */
async function buy(actor: Actor, quantity: number, useReward = false) {
  const lines = lattes(quantity);
  const quote = await quoteCart(db, actor, { lines, useReward }, NOW);
  const placed = await placeOrder(
    db,
    actor,
    {
      idempotencyKey: randomUUID(),
      lines,
      useReward,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Alex" },
      expectedTotalCents: quote.quote.totalCents,
      locale: "fr-CA",
    },
    opts,
  );
  if (placed.status === "awaiting_payment") {
    await simulateFakePayment(db, placed.orderId, "approve", {
      locale: "fr",
      guestToken: null,
      userId: actor.userId,
      now: NOW,
    });
  }
  const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
  return { orderId: placed.orderId, itemId: item!.id };
}

const orderRow = async (id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)))[0]!;

async function advance(orderId: string, to: string) {
  await transitionOrderAsStaff(
    db,
    staff,
    orderId,
    { to, expectedVersion: (await orderRow(orderId)).version },
    NOW,
  );
}

/** Takes a paid order through the kitchen so it can be refunded. */
async function complete(orderId: string) {
  const { status } = await orderRow(orderId);
  const flow = ["accepted", "in_preparation", "ready", "completed"];
  for (const to of flow.slice(flow.indexOf(status) + 1)) await advance(orderId, to);
}

async function account(actor: Actor) {
  return (
    await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, actor.userId))
  )[0]!;
}

async function entries(actor: Actor) {
  const { id } = await account(actor);
  return db
    .select()
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.accountId, id))
    .orderBy(asc(loyaltyTransactions.seq));
}

async function walletOf(actor: Actor) {
  const { id } = await account(actor);
  return db.select().from(rewards).where(eq(rewards.accountId, id)).orderBy(asc(rewards.issuedAt));
}

/** Every entry's running totals chain from the previous one and end at the cached balance. */
async function expectConsistentLedger(actor: Actor) {
  const rows = await entries(actor);
  let balance = 0;
  let debt = 0;
  for (const e of rows) {
    balance += e.stamps;
    debt += e.debtDelta;
    expect({ kind: e.kind, balanceAfter: e.balanceAfter, debtAfter: e.debtAfter }).toEqual({
      kind: e.kind,
      balanceAfter: balance,
      debtAfter: debt,
    });
  }
  const acc = await account(actor);
  expect({ balance: acc.stampBalance, debt: acc.stampDebt }).toEqual({ balance, debt });
  expect(acc.lifetimeStamps).toBe(
    rows.filter((e) => e.kind === "earn").reduce((s, e) => s + e.stamps, 0),
  );
}

/** The current rules as the admin form submits them (no version or metadata). */
async function ruleInput() {
  const current = await currentRules(db);
  return Object.fromEntries(
    Object.keys(programInput.shape).map((k) => [k, current[k as keyof typeof current]]),
  );
}

async function setRules(overrides: Record<string, unknown>) {
  return saveProgramVersion(db, owner, {
    ...(await ruleInput()),
    note: "test change",
    ...overrides,
  });
}

async function fullRefund(orderId: string, itemId: string, quantity: number) {
  return refundOrderAsStaff(
    db,
    lead,
    orderId,
    {
      amountCents: (await orderRow(orderId)).totalCents,
      reason: "Refund for test",
      items: [{ orderItemId: itemId, quantity }],
    },
    NOW,
  );
}

describe("earning", () => {
  it("earns one stamp per drink unit and turns every full card into a reward", async () => {
    // Demo customer: 2 stamps and one reward.
    const before = await account(customer);
    await buy(customer, 3);
    const after = await account(customer);
    expect(after.stampBalance).toBe(0);
    expect(after.lifetimeStamps - before.lifetimeStamps).toBe(3);
    expect((await walletOf(customer)).filter((r) => r.status === "available")).toHaveLength(2);

    const last = (await entries(customer)).slice(-2);
    expect(last.map((e) => e.kind)).toEqual(["earn", "convert"]);
    expect(last[0]!.details as LedgerDetails).toMatchObject({
      lines: [{ quantity: 3, stamps: 3, name: { en: "[DEMO] Latte" }, size: { en: "Large" } }],
      notCounted: [],
    });
    await expectConsistentLedger(customer);
  });

  it("a drink paid with a reward earns nothing; the paid drinks beside it do", async () => {
    const { orderId } = await buy(customer, 2, true);
    const earn = (await entries(customer)).find((e) => e.kind === "earn" && e.orderId === orderId)!;
    expect(earn.stamps).toBe(1);
    expect((earn.details as LedgerDetails).notCounted).toEqual([
      { name: { fr: "[DÉMO] Latte", en: "[DEMO] Latte" }, quantity: 1, reason: "reward_drink" },
    ]);
    expect((await entries(customer)).some((e) => e.kind === "redeem")).toBe(true);
    await expectConsistentLedger(customer);
  });

  it("simultaneous payments for one customer are applied one after another", async () => {
    const lines = lattes(3);
    const placed = await Promise.all(
      [0, 1].map(async () => {
        const quote = await quoteCart(db, customer, { lines }, NOW);
        return placeOrder(
          db,
          customer,
          {
            idempotencyKey: randomUUID(),
            lines,
            fulfilment: { method: "pickup", when: { kind: "asap" } },
            contact: { name: "Alex" },
            expectedTotalCents: quote.quote.totalCents,
            locale: "fr-CA",
          },
          opts,
        );
      }),
    );
    await Promise.all(
      placed.map((p) =>
        simulateFakePayment(db, p.orderId, "approve", {
          locale: "fr",
          guestToken: null,
          userId: customer.userId,
          now: NOW,
        }),
      ),
    );
    // 2 + 3 + 3 = 8 → one more reward, 3 left.
    expect((await account(customer)).stampBalance).toBe(3);
    expect((await walletOf(customer)).filter((r) => r.status === "available")).toHaveLength(2);
    await expectConsistentLedger(customer);
  });

  it("earns at completion instead of payment when the program says so", async () => {
    expect(await setRules({ earnOn: "completed" })).toEqual({ version: 2 });
    const before = await account(customer);
    const { orderId } = await buy(customer, 1);
    expect((await account(customer)).lifetimeStamps).toBe(before.lifetimeStamps);
    await complete(orderId);
    expect((await account(customer)).lifetimeStamps).toBe(before.lifetimeStamps + 1);
    const earn = (await entries(customer)).at(-1)!;
    expect(earn).toMatchObject({ kind: "earn", programVersion: 2 });
  });
});

describe("refunds and cancellations", () => {
  it("a partial refund takes back only the refunded drinks' stamps, never more than bought", async () => {
    const { orderId, itemId } = await buy(customer, 2); // 2 → 4 stamps
    await complete(orderId);
    const refund = (quantity: number) =>
      refundOrderAsStaff(
        db,
        lead,
        orderId,
        { amountCents: 100, reason: "Spilled drink", items: [{ orderItemId: itemId, quantity }] },
        NOW,
      );
    await refund(1);
    expect((await account(customer)).stampBalance).toBe(3);
    await refund(1);
    expect((await account(customer)).stampBalance).toBe(2);
    expect(await failure(refund(1))).toBe("validation_failed");
    const reversals = (await entries(customer)).filter((e) => e.kind === "reverse");
    expect(reversals.map((e) => (e.details as LedgerDetails).cause)).toEqual(["refund", "refund"]);
    expect(reversals.every((e) => e.refundId !== null)).toBe(true);
    await expectConsistentLedger(customer);
  });

  it("an unused reward covers a refund before any stamps are owed", async () => {
    const actor = await newCustomer();
    const { orderId, itemId } = await buy(actor, 6); // one reward, 1 stamp left
    await complete(orderId);
    await refundOrderAsStaff(
      db,
      lead,
      orderId,
      {
        amountCents: 300,
        reason: "Three were wrong",
        items: [{ orderItemId: itemId, quantity: 3 }],
      },
      NOW,
    );
    // 1 from the balance, then the reward's 5 come back and 2 of them are taken: 3 left.
    expect(await account(actor)).toMatchObject({ stampBalance: 3, stampDebt: 0 });
    expect((await walletOf(actor)).map((r) => r.status)).toEqual(["revoked"]);
    const tail = (await entries(actor)).slice(-2);
    expect(tail.map((e) => [e.kind, e.stamps])).toEqual([
      ["revoke", 5],
      ["reverse", -3],
    ]);
    await expectConsistentLedger(actor);
  });

  it("carry forward: stamps already spent on a used reward are owed and settled by the next purchase", async () => {
    const actor = await newCustomer();
    const first = await buy(actor, 5); // a full card
    await buy(actor, 1, true); // the free drink is used ($0 order)
    await complete(first.orderId);
    await fullRefund(first.orderId, first.itemId, 5);
    expect(await account(actor)).toMatchObject({ stampBalance: 0, stampDebt: 5 });
    expect((await orderRow(first.orderId)).status).toBe("refunded");

    await buy(actor, 2);
    expect(await account(actor)).toMatchObject({ stampBalance: 0, stampDebt: 3 });
    expect((await entries(actor)).at(-1)).toMatchObject({
      kind: "repay",
      stamps: -2,
      debtDelta: -2,
    });
    await expectConsistentLedger(actor);
  });

  it("forgive: the shortfall is written off and recorded on the reversal", async () => {
    await setRules({ refundShortfallPolicy: "forgive" });
    const actor = await newCustomer();
    const first = await buy(actor, 5);
    await buy(actor, 1, true);
    await complete(first.orderId);
    await fullRefund(first.orderId, first.itemId, 5);
    expect(await account(actor)).toMatchObject({ stampBalance: 0, stampDebt: 0 });
    const reverse = (await entries(actor)).find((e) => e.kind === "reverse")!;
    expect(reverse.details).toMatchObject({ forgiven: 5, cause: "refund" });
    await expectConsistentLedger(actor);
  });

  it("a refunded order gives its free drink back, unless the program keeps it used", async () => {
    const reinstated = await buy(customer, 2, true);
    await complete(reinstated.orderId);
    await fullRefund(reinstated.orderId, reinstated.itemId, 2);
    expect((await walletOf(customer)).map((r) => r.status)).toEqual(["available"]);
    expect((await entries(customer)).at(-1)).toMatchObject({ kind: "reinstate" });

    await setRules({ rewardOnRefund: "keep_redeemed" });
    const kept = await buy(customer, 2, true);
    await complete(kept.orderId);
    await fullRefund(kept.orderId, kept.itemId, 2);
    expect((await walletOf(customer)).map((r) => r.status)).toEqual(["redeemed"]);
    await expectConsistentLedger(customer);
  });

  it("cancelling a paid order takes its stamps back once, even as the refund settles", async () => {
    const { orderId } = await buy(customer, 2);
    await transitionOrderAsStaff(
      db,
      staff,
      orderId,
      { to: "rejected", reason: "Out of milk", expectedVersion: (await orderRow(orderId)).version },
      NOW,
    );
    expect((await account(customer)).stampBalance).toBe(2);
    expect((await entries(customer)).filter((e) => e.kind === "reverse")).toHaveLength(1);
    await expectConsistentLedger(customer);
  });
});

describe("program versions", () => {
  it("only the owner changes the rules; every change is a new, audited version", async () => {
    const input = { ...(await ruleInput()), stampsPerReward: 8, note: "Eight drinks" };
    expect(await failure(saveProgramVersion(db, lead, input))).toBe("forbidden");
    expect(await failure(saveProgramVersion(db, owner, { ...input, stampsPerReward: 1 }))).toBe(
      "validation_failed",
    );
    expect(
      await failure(
        saveProgramVersion(db, owner, { ...input, excludedProductIds: [randomUUID()] }),
      ),
    ).toBe("validation_failed");
    expect(await saveProgramVersion(db, owner, input)).toEqual({ version: 2 });
    expect(await failure(saveProgramVersion(db, owner, input))).toBe("no_changes");

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "loyalty.rules_changed"));
    expect(audit!.metadata).toMatchObject({
      from: 1,
      changed: { stampsPerReward: { from: 5, to: 8 } },
    });
  });

  it("new rules apply from now on; rewards already issued keep the terms they were issued with", async () => {
    await setRules({ stampsPerReward: 3, rewardValueCapCents: 300 });
    const [old] = await walletOf(customer);
    expect(old).toMatchObject({ programVersion: 1, stampsCost: 5, valueCapCents: null });
    await buy(customer, 1); // 2 + 1 = 3 → a reward under version 2
    const issued = (await walletOf(customer)).find((r) => r.id !== old!.id)!;
    expect(issued).toMatchObject({ programVersion: 2, stampsCost: 3, valueCapCents: 300 });
  });

  it("rewards expire only under a program that sets an expiry", async () => {
    await setRules({ rewardExpiryDays: 30 });
    const actor = await newCustomer();
    await buy(actor, 5);
    const [reward] = await walletOf(actor);
    expect(reward!.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));

    const soon = await getLoyaltySummary(db, actor, { now: NOW });
    expect(soon.availableRewards).toHaveLength(1);
    const later = await getLoyaltySummary(db, actor, {
      now: new Date(NOW.getTime() + 31 * 86_400_000),
    });
    expect(later.availableRewards).toHaveLength(0);
    expect(later.history[0]).toMatchObject({ kind: "expire", stamps: 0 });
    // The demo customer's reward predates the expiry rule and never expires.
    const demo = await getLoyaltySummary(db, customer, {
      now: new Date(NOW.getTime() + 400 * 86_400_000),
    });
    expect(demo.availableRewards).toHaveLength(1);
  });
});

describe("card codes", () => {
  it("issues a short-lived code per customer, reused while fresh", async () => {
    const first = await issueCardCode(db, customer, NOW);
    expect(first.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(await issueCardCode(db, customer, new Date(NOW.getTime() + 60_000))).toEqual(first);
    const renewed = await issueCardCode(db, customer, new Date(NOW.getTime() + 9 * 60_000));
    expect(renewed.code).not.toBe(first.code);
    expect(await failure(issueCardCode(db, null, NOW))).toBe("unauthenticated");
  });
});

describe("in-store visits", () => {
  let muffin: CatalogProduct;
  beforeEach(async () => {
    muffin = (await getProductBySlug(db, "demo-muffin"))!;
  });
  const small = () => ({ productId: latte.id, variantId: latte.variants[0]!.id, quantity: 1 });
  const large = (quantity = 1) => ({
    productId: latte.id,
    variantId: latte.variants[1]!.id,
    quantity,
  });
  const visit = async (
    items: Array<{ productId: string; variantId: string; quantity: number }>,
    extra: Record<string, unknown> = {},
  ) => {
    const { code } = await issueCardCode(db, customer, NOW);
    const receiptReference = `R-${randomUUID().slice(0, 8)}`;
    return recordInStoreVisit(
      db,
      staff,
      { code, receiptReference, items, idempotencyKey: randomUUID(), ...extra },
      NOW,
    );
  };

  it("staff stamp a counter purchase from the customer's code, once per receipt", async () => {
    const { code } = await issueCardCode(db, customer, NOW);
    expect(await lookupCardCode(db, staff, code.toLowerCase(), NOW)).toMatchObject({
      firstName: "Demo",
      stampBalance: 2,
      availableRewards: 1,
    });
    expect(await failure(lookupCardCode(db, customer, code, NOW))).toBe("forbidden");
    expect(
      await failure(lookupCardCode(db, staff, code, new Date(NOW.getTime() + 11 * 60_000))),
    ).toBe("card_code_invalid");

    const input = {
      code,
      receiptReference: "a-1001",
      items: [large(2), { productId: muffin.id, variantId: muffin.variants[0]!.id, quantity: 1 }],
      idempotencyKey: randomUUID(),
    };
    const first = await recordInStoreVisit(db, staff, input, NOW);
    expect(first).toMatchObject({ stampsEarned: 2, stampBalance: 4, replayed: false });
    expect(await recordInStoreVisit(db, staff, input, NOW)).toMatchObject({
      visitId: first.visitId,
      replayed: true,
      stampBalance: 4,
    });
    const sameReceipt = { ...input, receiptReference: "A 1001", idempotencyKey: randomUUID() };
    expect(await failure(recordInStoreVisit(db, staff, sameReceipt, NOW))).toBe("receipt_recorded");

    const earn = (await entries(customer)).at(-1)!;
    expect(earn).toMatchObject({ kind: "earn", source: "in_store", inStoreVisitId: first.visitId });
    // The muffin isn't a drink, so it isn't listed as "not counted" either.
    expect(earn.details).toMatchObject({ receiptReference: "A1001", notCounted: [] });
    await expectConsistentLedger(customer);
  });

  it("a reward makes the most expensive eligible drink free, and that drink earns nothing", async () => {
    const result = await visit([small(), large()], { useReward: true });
    expect(result).toMatchObject({ stampsEarned: 1, rewardUsed: true, stampBalance: 3 });
    const [redemption] = await db
      .select()
      .from(rewardRedemptions)
      .where(eq(rewardRedemptions.inStoreVisitId, result.visitId));
    expect(redemption).toMatchObject({ status: "committed", discountCents: 200 });
    expect((await walletOf(customer)).map((r) => r.status)).toEqual(["redeemed"]);
    expect(await failure(visit([large()], { useReward: true }))).toBe("reward_unavailable");
    await expectConsistentLedger(customer);
  });

  it("caps stamps per visit and per café day, and can be switched off", async () => {
    await setRules({ inStoreMaxStampsPerVisit: 3, inStoreMaxStampsPerDay: 4 });
    expect((await visit([large(5)])).stampsEarned).toBe(3);
    expect((await visit([large(2)])).stampsEarned).toBe(1);
    const capped = await db.select().from(loyaltyInStoreVisits);
    expect(capped.map((v) => v.items[0])).toContainEqual(
      expect.objectContaining({ quantity: 5, stamps: 3 }),
    );

    await setRules({ inStoreEnabled: false });
    expect(await failure(visit([large()]))).toBe("in_store_disabled");
  });

  it("voiding a visit takes its stamps back and returns its free drink — shift lead, once", async () => {
    const { visitId } = await visit([small(), large()], { useReward: true });
    const reason = { reason: "Wrong customer" };
    expect(await failure(voidInStoreVisit(db, staff, visitId, reason, NOW))).toBe("forbidden");
    expect(await voidInStoreVisit(db, lead, visitId, reason, NOW)).toEqual({
      stampBalance: 2,
      stampDebt: 0,
    });
    expect(await failure(voidInStoreVisit(db, lead, visitId, reason, NOW))).toBe(
      "visit_already_voided",
    );
    expect((await walletOf(customer)).map((r) => r.status)).toEqual(["available"]);
    const tail = (await entries(customer)).slice(-2);
    expect(tail.map((e) => e.kind)).toEqual(["reverse", "reinstate"]);
    expect(tail[0]).toMatchObject({
      reason: "Wrong customer",
      details: { cause: "in_store_void" },
    });
    await expectConsistentLedger(customer);
  });
});

describe("staff support", () => {
  const key = () => randomUUID();
  const adjust = (actor: Actor, userId: string, input: Record<string, unknown>) =>
    adjustLoyalty(db, actor, userId, { idempotencyKey: key(), ...input }, NOW);

  it("finds a customer by email or code with minimum personal information", async () => {
    const match = await findLoyaltyCustomer(db, staff, `CUSTOMER@${DEMO_EMAIL_DOMAIN}`, NOW);
    expect(match).toEqual({
      userId: customer.userId,
      firstName: "Demo",
      maskedEmail: `c•••@${DEMO_EMAIL_DOMAIN}`,
    });
    const { code } = await issueCardCode(db, customer, NOW);
    expect((await findLoyaltyCustomer(db, staff, code, NOW))?.userId).toBe(customer.userId);
    expect(await findLoyaltyCustomer(db, staff, `staff@${DEMO_EMAIL_DOMAIN}`, NOW)).toBeNull();
    expect(await failure(findLoyaltyCustomer(db, customer, code, NOW))).toBe("forbidden");

    const view = await getCustomerLoyalty(db, staff, customer.userId);
    expect(view).toMatchObject({ stampBalance: 2, rewards: [{ status: "available" }] });
    expect(JSON.stringify(view)).not.toContain(`customer@${DEMO_EMAIL_DOMAIN}`);
  });

  it("shift leads correct a card with a reason; retries change nothing; all audited", async () => {
    const add = {
      action: "stamps",
      stamps: 3,
      reason: "Missed stamps last week",
      idempotencyKey: key(),
    };
    expect(await failure(adjustLoyalty(db, staff, customer.userId, add, NOW))).toBe("forbidden");
    expect(await adjustLoyalty(db, lead, customer.userId, add, NOW)).toEqual({
      stampBalance: 0,
      stampDebt: 0,
      rewardsIssued: 1,
    });
    await adjustLoyalty(db, lead, customer.userId, add, NOW); // retried
    expect((await account(customer)).stampBalance).toBe(0);
    expect((await walletOf(customer)).filter((r) => r.status === "available")).toHaveLength(2);

    const remove = { action: "stamps", stamps: -1, reason: "Too many" };
    expect(await failure(adjust(lead, customer.userId, remove))).toBe("validation_failed");
    const silent = { action: "stamps", stamps: 2, reason: "" };
    expect(await failure(adjust(lead, customer.userId, silent))).toBe("validation_failed");
    const forgive = { action: "forgive_debt", reason: "Goodwill" };
    expect(await failure(adjust(lead, customer.userId, forgive))).toBe("no_debt");
    expect(await failure(adjust(lead, lead.userId, { ...add, idempotencyKey: key() }))).toBe(
      "own_account",
    );

    const [reward] = await walletOf(customer);
    const voidReward = { action: "void_reward", rewardId: reward!.id, reason: "Issued by mistake" };
    await adjust(lead, customer.userId, voidReward);
    expect(await failure(adjust(lead, customer.userId, voidReward))).toBe("reward_not_available");
    expect((await entries(customer)).at(-1)).toMatchObject({
      kind: "revoke",
      stamps: 0,
      reason: "Issued by mistake",
      actorUserId: lead.userId,
    });

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "loyalty.adjusted"));
    expect(audits.map((a) => (a.metadata as { action: string }).action)).toEqual([
      "stamps",
      "void_reward",
    ]);
    await expectConsistentLedger(customer);
  });

  it("forgiving stamps owed clears the debt without touching the balance", async () => {
    const actor = await newCustomer();
    const first = await buy(actor, 5);
    await buy(actor, 1, true);
    await complete(first.orderId);
    await fullRefund(first.orderId, first.itemId, 5);
    expect((await account(actor)).stampDebt).toBe(5);
    await adjust(lead, actor.userId, { action: "forgive_debt", reason: "Goodwill" });
    expect(await account(actor)).toMatchObject({ stampBalance: 0, stampDebt: 0 });
    await expectConsistentLedger(actor);
  });
});
