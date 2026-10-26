import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  giftCards,
  giftCardTransactions,
  orders,
  payments,
  refunds,
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
import {
  adjustGiftCard,
  checkGiftCardBalance,
  giftCardLiability,
  issueGiftCard,
  lookupGiftCard,
  redeemAtCounter,
  setGiftCardStatus,
} from "./gift-cards/gift-cards";
import { quoteCart } from "./ordering/cart-quote";
import { expireStaleOrders } from "./ordering/lifecycle";
import { refundOrderAsStaff, transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment, startCheckout } from "./payments/checkout";
import { getSalesReport } from "./reports/sales";

/*
 * Gift cards against a real database: issued at the counter (code shown once, only its hash
 * kept), checked and spent at the counter and online (as part or all of an order's payment, after
 * tax), held while an order is unpaid and released if it isn't paid, and given back on refunds —
 * card money first, then the gift card. A balance never goes below zero, even under concurrency.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const opts = { provider: "fake" as const, now: NOW };

let handle: DbHandle;
let db: Database;
let customer: Actor;
let staff: Actor;
let lead: Actor;
let manager: Actor;
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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, gift_cards restart identity cascade`,
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
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

const optionId = (nameEn: string) =>
  latte.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
/** Large latte, hot, whole milk: 2,00 $ + taxes = 2,30 $. */
const latteLine = (quantity = 1) => ({
  lineId: randomUUID(),
  productId: latte.id,
  variantId: latte.variants[1]!.id,
  optionIds: [optionId("Hot"), optionId("Whole milk")],
  quantity,
});

async function orderInput(giftCardCode?: string, quantity = 1) {
  const lines = [latteLine(quantity)];
  const quote = await quoteCart(db, customer, { lines, giftCardCode }, NOW);
  return {
    idempotencyKey: randomUUID(),
    lines,
    fulfilment: { method: "pickup", when: { kind: "asap" } },
    contact: { name: "Alex" },
    expectedTotalCents: quote.quote.totalCents,
    ...(giftCardCode ? { giftCardCode, expectedAmountDueCents: quote.quote.amountDueCents } : {}),
    locale: "fr-CA",
  };
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

const issue = (amountCents: number) => issueGiftCard(db, lead, { amountCents });
const balanceOf = async (id: string) =>
  (await db.select().from(giftCards).where(eq(giftCards.id, id)))[0]!.balanceCents;
const orderRow = async (id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)))[0]!;

async function pay(orderId: string) {
  await startCheckout(db, customer, orderId, null, "fr", NOW);
  return simulateFakePayment(db, orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: customer.userId,
    now: NOW,
  });
}

async function moveTo(orderId: string, to: string, reason?: string) {
  const order = await orderRow(orderId);
  return transitionOrderAsStaff(
    db,
    to === "cancelled" ? lead : staff,
    orderId,
    { to, reason, expectedVersion: order.version },
    NOW,
  );
}

describe("issuing and checking", () => {
  it("issues a card paid at the counter: the code is shown once and only its hash is kept", async () => {
    const card = await issue(2500);
    expect(card.code).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    const [row] = await db.select().from(giftCards).where(eq(giftCards.id, card.id));
    expect(row).toMatchObject({ initialCents: 2500, balanceCents: 2500, status: "active" });
    expect(JSON.stringify(row)).not.toContain(card.code.replace(/-/g, ""));
    const ledger = await db
      .select()
      .from(giftCardTransactions)
      .where(eq(giftCardTransactions.giftCardId, card.id));
    expect(ledger.map((t) => [t.kind, t.deltaCents, t.balanceAfterCents])).toEqual([
      ["issue", 2500, 2500],
    ]);
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "gift_card.issued")),
    ).toHaveLength(1);
  });

  it("anyone can check a balance with the code as typed; nothing else is revealed", async () => {
    const card = await issue(1000);
    const typed = card.code.toLowerCase().replace(/-/g, " ");
    expect(await checkGiftCardBalance(db, { code: typed })).toEqual({
      last4: card.last4,
      balanceCents: 1000,
      status: "active",
    });
    expect(await failure(checkGiftCardBalance(db, { code: "AAAA-BBBB-CCCC-DDDD" }))).toBe(
      "not_found",
    );
  });

  it("only shift leads issue, only managers adjust, and amounts stay within limits", async () => {
    expect(await failure(issueGiftCard(db, staff, { amountCents: 2000 }))).toBe("forbidden");
    expect(await failure(issueGiftCard(db, lead, { amountCents: 100 }))).toBe("validation_failed");
    const card = await issue(2000);
    expect(await failure(adjustGiftCard(db, lead, card.id, { deltaCents: 500, reason: "x" }))).toBe(
      "forbidden",
    );
    const adjusted = await adjustGiftCard(db, manager, card.id, {
      deltaCents: -500,
      reason: "Entered twice",
    });
    expect(adjusted.balanceCents).toBe(1500);
    expect(
      await failure(
        adjustGiftCard(db, manager, card.id, { deltaCents: -9999, reason: "Too much" }),
      ),
    ).toBe("gift_card_insufficient");
  });
});

describe("at the counter", () => {
  it("staff look a card up by code and take a purchase off it; the ledger keeps every step", async () => {
    const card = await issue(1000);
    const found = await lookupGiftCard(db, staff, { code: card.code });
    expect(found).toMatchObject({ balanceCents: 1000, status: "active", last4: card.last4 });
    const after = await redeemAtCounter(db, staff, card.id, { amountCents: 450, note: "2 lattes" });
    expect(after.balanceCents).toBe(550);
    expect(after.history.map((h) => [h.kind, h.deltaCents])).toEqual([
      ["redeem", -450],
      ["issue", 1000],
    ]);
    expect(await failure(redeemAtCounter(db, staff, card.id, { amountCents: 600 }))).toBe(
      "gift_card_insufficient",
    );
  });

  it("a disabled card can't be spent until it is enabled again; its balance is kept", async () => {
    const card = await issue(1000);
    await setGiftCardStatus(db, lead, card.id, { status: "disabled", reason: "Reported lost" });
    expect(await failure(redeemAtCounter(db, staff, card.id, { amountCents: 100 }))).toBe(
      "gift_card_disabled",
    );
    expect(await failure(placeOrder(db, customer, await orderInput(card.code), opts))).toBe(
      "gift_card_disabled",
    );
    await setGiftCardStatus(db, lead, card.id, { status: "active", reason: "Found" });
    expect((await redeemAtCounter(db, staff, card.id, { amountCents: 100 })).balanceCents).toBe(
      900,
    );
  });

  it("the same card spent twice at once never goes below zero", async () => {
    const card = await issue(1000);
    const results = await Promise.all(
      [700, 700].map((amountCents) =>
        failure(redeemAtCounter(db, staff, card.id, { amountCents })),
      ),
    );
    expect(results.sort()).toEqual(["gift_card_insufficient", null].sort());
    expect(await balanceOf(card.id)).toBe(300);
  });
});

describe("paying online", () => {
  it("the quote shows the card paying part of the total after tax; the rest is charged by card", async () => {
    const card = await issue(1000);
    const quote = await quoteCart(
      db,
      customer,
      { lines: [latteLine(5)], giftCardCode: card.code },
      NOW,
    );
    expect(quote.giftCard).toEqual({ status: "applied", last4: card.last4, balanceCents: 1000 });
    expect(quote.quote).toMatchObject({
      totalCents: 1150,
      giftCardCents: 1000,
      amountDueCents: 150,
    });
    // Taxes are those of the drinks, whatever pays for them.
    expect(quote.quote.gstCents + quote.quote.qstCents).toBe(150);
    const unknown = await quoteCart(
      db,
      customer,
      { lines: [latteLine()], giftCardCode: "AAAA-BBBB-CCCC-DDDD" },
      NOW,
    );
    expect(unknown.giftCard?.status).toBe("not_found");
    expect(unknown.quote.giftCardCents).toBe(0);
  });

  it("a partly covered order is charged only what's left, and the card is debited once", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code, 5), opts);
    expect(placed).toMatchObject({
      totalCents: 1150,
      amountDueCents: 150,
      status: "awaiting_payment",
    });
    expect(await balanceOf(card.id)).toBe(0);
    await pay(placed.orderId);
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    expect(payment?.amountCents).toBe(150);
    expect(await orderRow(placed.orderId)).toMatchObject({
      status: "paid",
      giftCardId: card.id,
      giftCardCents: 1000,
    });
  });

  it("an order the card covers in full is paid at once, with no card payment", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code), opts);
    expect(placed).toMatchObject({ status: "paid", amountDueCents: 0 });
    expect(await balanceOf(card.id)).toBe(770);
    expect(await db.select().from(payments).where(eq(payments.orderId, placed.orderId))).toEqual(
      [],
    );
  });

  it("never leaves less than 0,50 $ to charge: the card then pays a little less", async () => {
    const card = await issue(500);
    await redeemAtCounter(db, staff, card.id, { amountCents: 300 }); // 2,00 $ left
    const placed = await placeOrder(db, customer, await orderInput(card.code), opts);
    expect(placed.amountDueCents).toBe(50);
    expect(await balanceOf(card.id)).toBe(20);
  });

  it("a balance that changed since the quote refuses the order instead of charging more", async () => {
    const card = await issue(1000);
    const input = await orderInput(card.code, 5); // shown: 1,50 $ to pay
    await redeemAtCounter(db, staff, card.id, { amountCents: 400 });
    expect(await failure(placeOrder(db, customer, input, opts))).toBe("price_changed");
    expect(await balanceOf(card.id)).toBe(600);
  });

  it("an unpaid order that expires gives its hold back to the card, once", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code, 5), opts);
    expect(await balanceOf(card.id)).toBe(0);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await db.transaction((tx) => expireStaleOrders(tx, later));
    await db.transaction((tx) => expireStaleOrders(tx, later));
    expect(await balanceOf(card.id)).toBe(1000);
    expect((await orderRow(placed.orderId)).status).toBe("expired");
  });
});

describe("refunds", () => {
  it("cancelling a paid order gives the card payment back and puts the rest on the gift card", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code, 5), opts);
    await pay(placed.orderId);
    await moveTo(placed.orderId, "cancelled", "Out of milk");
    expect(await balanceOf(card.id)).toBe(1000);
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, placed.orderId));
    expect(rows.map((r) => [r.amountCents, r.status, r.giftCardId !== null]).sort()).toEqual(
      [
        [1000, "succeeded", true],
        [150, "succeeded", false],
      ].sort(),
    );
    expect((await orderRow(placed.orderId)).status).toBe("refunded");
  });

  it("a partial refund of a completed order takes card money first, then the gift card", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code, 5), opts);
    await pay(placed.orderId);
    for (const to of ["accepted", "in_preparation", "ready", "completed"])
      await moveTo(placed.orderId, to);

    await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 400, reason: "Cold drinks" },
      NOW,
    );
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    expect(payment).toMatchObject({ refundedCents: 150, status: "refunded" });
    expect(await balanceOf(card.id)).toBe(250);
    expect((await orderRow(placed.orderId)).status).toBe("partially_refunded");

    // The rest goes back to the gift card; nothing more can be refunded.
    await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 750, reason: "Goodwill" },
      NOW,
    );
    expect(await balanceOf(card.id)).toBe(1000);
    expect((await orderRow(placed.orderId)).status).toBe("refunded");
    expect(
      await failure(
        refundOrderAsStaff(db, lead, placed.orderId, { amountCents: 1, reason: "More" }, NOW),
      ),
    ).toBe("refund_not_allowed");
  });

  it("an order paid only by gift card is refunded to the card", async () => {
    const card = await issue(1000);
    const placed = await placeOrder(db, customer, await orderInput(card.code), opts);
    for (const to of ["accepted", "in_preparation", "ready", "completed"])
      await moveTo(placed.orderId, to);
    const result = await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 230, reason: "Wrong order" },
      NOW,
    );
    expect(result).toMatchObject({ status: "refunded", refundStatus: "succeeded" });
    expect(await balanceOf(card.id)).toBe(1000);
  });
});

describe("reports", () => {
  it("the sales report reconciles card payments plus gift cards with the order totals", async () => {
    const card = await issue(1000);
    const partly = await placeOrder(db, customer, await orderInput(card.code, 5), opts); // 1,50 $ due
    await pay(partly.orderId);
    const other = await issue(1000);
    await placeOrder(db, customer, await orderInput(other.code), opts); // covered: 2,30 $
    // Demo menu items: include demo orders in this report.
    const report = await getSalesReport(db, manager, {
      from: "2026-10-12",
      to: "2026-10-12",
      includeDemo: true,
    });
    expect(report.reconciliation.mismatches).toEqual([]);
    expect(report.reconciliation.giftCardsCents).toBe(1000 + 230);
    expect(report.giftCards.outstandingCents).toBe(1000 - 230);
  });
});

describe("liability", () => {
  it("reports what is owed on cards and what moved in the period", async () => {
    const a = await issue(2000);
    await issue(1000);
    await redeemAtCounter(db, staff, a.id, { amountCents: 500 });
    const placed = await placeOrder(db, customer, await orderInput(a.code), opts); // 2,30 $
    await db.transaction((tx) => expireStaleOrders(tx, new Date(NOW.getTime() + 3_600_000))); // paid at once: nothing released
    expect((await orderRow(placed.orderId)).status).toBe("paid");
    const report = await giftCardLiability(
      db,
      new Date(Date.now() - 86_400_000),
      new Date(Date.now() + 86_400_000),
    );
    expect(report).toEqual({
      outstandingCents: 3000 - 500 - 230,
      cardsWithBalance: 2,
      issuedCents: 3000,
      redeemedCents: 730,
      adjustedCents: 0,
    });
  });
});
