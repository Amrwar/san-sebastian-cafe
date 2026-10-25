import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  auditEvents,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  loyaltyAccounts,
  orders,
  payments,
  products,
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
import { adjustLoyalty } from "./loyalty/staff";
import { quoteCart } from "./ordering/cart-quote";
import { refundOrderAsStaff, transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";
import { exportReportCsv } from "./reports/export";
import { getSalesReport } from "./reports/sales";

/*
 * Reporting against real orders, payments and refunds made through the ordering and payment
 * services (development payment simulator). Totals must reconcile with the order and payment
 * tables to the cent, in the café's time zone.
 */

// Montréal is UTC−4 in October (EDT). The demo café is open 07:00–18:00.
const at = (local: string) => new Date(`${local}:00-04:00`);
const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const THU = "2026-10-15";

let handle: DbHandle;
let db: Database;
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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs restart identity cascade`,
  );
  await seedDemoData(db, at(`${MON}T10:00`));
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
  // Orders of demo products are demo orders, which reports leave out: make the latte a real product.
  await db.update(products).set({ isDemo: false }).where(eq(products.id, latte.id));
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

/** A real (non-demo) customer account. */
async function newCustomer(): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "", email: `${userId}@example.test` });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}

/** Large lattes (2,00 $ each before tax), placed and paid at `when`. */
async function buy(
  actor: Actor,
  when: Date,
  { quantity = 1, tipCents = 0, useReward = false, pay = true } = {},
) {
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
  const tip =
    tipCents > 0 ? { kind: "amount" as const, cents: tipCents } : { kind: "none" as const };
  const { quote } = await quoteCart(db, actor, { lines, tip, useReward }, when);
  if (!quote.canCheckout)
    throw new Error(
      `cannot order at ${when.toISOString()}: ${JSON.stringify([quote.issues, quote.lines.map((l) => l.issues)])}`,
    );
  const placed = await placeOrder(
    db,
    actor,
    {
      idempotencyKey: randomUUID(),
      lines,
      tip,
      useReward,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Alex" },
      expectedTotalCents: quote.totalCents,
      locale: "fr-CA",
    },
    { provider: "fake", now: when },
  );
  if (pay && placed.status === "awaiting_payment") {
    await simulateFakePayment(db, placed.orderId, "approve", {
      locale: "fr",
      guestToken: null,
      userId: actor.userId,
      now: when,
    });
  }
  return placed.orderId;
}

async function orderRow(id: string) {
  return (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
}

/** Takes a paid order through the kitchen so it can be refunded. */
async function complete(orderId: string, when: Date) {
  const flow = ["accepted", "in_preparation", "ready", "completed"];
  const { status } = await orderRow(orderId);
  for (const to of flow.slice(flow.indexOf(status) + 1)) {
    const { version } = await orderRow(orderId);
    await transitionOrderAsStaff(db, staff, orderId, { to, expectedVersion: version }, when);
  }
}

async function refund(orderId: string, amountCents: number, when: Date, reason = "Café renversé") {
  await refundOrderAsStaff(db, lead, orderId, { amountCents, reason }, when);
}

const report = (from: string, to = from) => getSalesReport(db, manager, { from, to });

/**
 * The week's fixtures:
 * - Monday 10:00: 1 latte (2,30 $: 2,00 + GST 0,10 + QST 0,20).
 * - Monday 11:00: 2 lattes with a 0,75 $ tip.
 * - Monday 17:00, paid 23:30: 1 latte; 03:30 UTC on Tuesday, but Monday at the café.
 * - Tuesday 09:00: 1 latte, refunded 1,00 $ on Wednesday and the rest (1,30 $) on Thursday.
 * - Tuesday 12:00: an order left unpaid.
 */
async function week() {
  const alex = await newCustomer();
  const o1 = await buy(alex, at(`${MON}T10:00`));
  const o2 = await buy(alex, at(`${MON}T11:00`), { quantity: 2, tipCents: 75 });
  const o4 = await buy(alex, at(`${MON}T17:00`));
  await db
    .update(orders)
    .set({ paidAt: new Date("2026-10-13T03:30:00Z") })
    .where(eq(orders.id, o4));
  const o3 = await buy(alex, at(`${TUE}T09:00`));
  await complete(o3, at(`${TUE}T09:30`));
  await refund(o3, 100, at(`${WED}T12:00`));
  await refund(o3, 130, at(`${THU}T12:00`));
  const unpaid = await buy(alex, at(`${TUE}T12:00`), { pay: false });
  return { alex, o1, o2, o3, o4, unpaid };
}

describe("sales report", () => {
  it("reconciles with the order and payment tables to the cent", async () => {
    const { o1, o2, o3, o4 } = await week();
    const r = await report(MON, THU);

    const paid = await db
      .select()
      .from(orders)
      .where(and(eq(orders.isDemo, false), sql`${orders.paidAt} is not null`));
    expect(paid.map((o) => o.id).sort()).toEqual([o1, o2, o3, o4].sort());
    const sum = (k: "totalCents" | "gstCents" | "qstCents" | "tipCents") =>
      paid.reduce((s, o) => s + o[k], 0);

    expect(r.sales.orders).toBe(4);
    expect(r.sales.totalCents).toBe(sum("totalCents"));
    expect(r.sales.gstCents).toBe(sum("gstCents"));
    expect(r.sales.qstCents).toBe(sum("qstCents"));
    expect(r.sales.tipCents).toBe(75);
    expect(r.sales.goodsCents + r.sales.gstCents + r.sales.qstCents + r.sales.tipCents).toBe(
      r.sales.totalCents,
    );
    // Five lattes at 2,00 $.
    expect(r.sales.goodsCents).toBe(1000);
    expect(r.sales.itemsCents).toBe(1000);

    // Every sale has its payment, for the same amount.
    const ours = await db
      .select()
      .from(payments)
      .where(and(isNull(payments.reconciliation), inArray(payments.orderId, [o1, o2, o3, o4])));
    expect(ours.map((p) => p.status).sort()).toEqual([
      "refunded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(ours.find((p) => p.orderId === o3)).toMatchObject({ refundedCents: 230 });
    expect(r.reconciliation.paymentsCents).toBe(ours.reduce((s, p) => s + p.amountCents, 0));
    expect(r.reconciliation.paymentsCents).toBe(r.sales.totalCents);
    expect(r.reconciliation.mismatches).toEqual([]);

    // The whole of order 3 came back: exactly its GST and QST.
    expect(r.refunds).toMatchObject({
      count: 2,
      totalCents: 230,
      goodsCents: 200,
      gstCents: 10,
      qstCents: 20,
      tipCents: 0,
      bySource: [{ source: "staff", count: 2, totalCents: 230 }],
    });
    expect(r.net).toEqual({
      goodsCents: r.sales.goodsCents - 200,
      gstCents: r.sales.gstCents - 10,
      qstCents: r.sales.qstCents - 20,
      tipCents: 75,
      totalCents: r.sales.totalCents - 230,
    });
    expect(r.demoOrdersExcluded).toBe(
      (
        await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.isDemo, true),
              gte(orders.paidAt, at(`${MON}T00:00`)),
              lt(orders.paidAt, at("2026-10-16T00:00")),
            ),
          )
      ).length,
    );
  });

  it("counts days and hours at the café, not in UTC", async () => {
    await week();
    const r = await report(MON, THU);
    expect(r.days.map((d) => [d.date, d.sales.orders, d.refundsCents])).toEqual([
      [MON, 3, 0],
      [TUE, 1, 0],
      [WED, 0, 100],
      [THU, 0, 130],
    ]);
    const busy = r.hours.filter((h) => h.orders > 0).map((h) => [h.hour, h.orders]);
    expect(busy).toEqual([
      [9, 1],
      [10, 1],
      [11, 1],
      [23, 1],
    ]);
    // Tuesday alone: the order paid at 03:30 UTC Tuesday belongs to Monday.
    expect((await report(TUE)).sales.orders).toBe(1);
    expect((await report(MON)).sales.orders).toBe(3);
  });

  it("splits each partial refund pro rata, whichever period is asked", async () => {
    await week();
    // 1,00 $ of a 2,30 $ order (2,00 + 0,10 + 0,20): 0,87 + 0,04 + 0,09.
    expect((await report(WED)).refunds).toMatchObject({
      totalCents: 100,
      goodsCents: 87,
      gstCents: 4,
      qstCents: 9,
    });
    // The rest makes up the order exactly.
    expect((await report(THU)).refunds).toMatchObject({
      totalCents: 130,
      goodsCents: 113,
      gstCents: 6,
      qstCents: 11,
    });
  });

  it("lists sales by product, category and tax category", async () => {
    await week();
    const r = await report(MON, THU);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]).toMatchObject({
      productId: latte.id,
      quantity: 5,
      freeUnits: 0,
      salesCents: 1000,
    });
    expect(r.categories).toMatchObject([{ quantity: 5, salesCents: 1000 }]);
    expect(r.taxCategories).toEqual([{ taxCategory: "standard", salesCents: 1000 }]);
  });

  it("flags a paid order whose payment doesn't match", async () => {
    const { o1 } = await week();
    await db.update(payments).set({ amountCents: 200 }).where(eq(payments.orderId, o1));
    const r = await report(MON);
    expect(r.reconciliation.mismatches).toEqual([
      { orderId: o1, number: (await orderRow(o1)).number, totalCents: 230, paidCents: 200 },
    ]);
  });

  it("leaves demo orders out unless asked", async () => {
    const { o1 } = await week();
    // The seed already has one demo order paid on Monday.
    expect(await report(MON)).toMatchObject({ demoOrdersExcluded: 1, sales: { orders: 3 } });
    await db.update(orders).set({ isDemo: true }).where(eq(orders.id, o1));
    const without = await report(MON);
    expect(without).toMatchObject({ demoOrdersExcluded: 2, sales: { orders: 2 } });
    const withDemo = await getSalesReport(db, manager, { from: MON, to: MON, includeDemo: true });
    expect(withDemo).toMatchObject({ demoOrdersExcluded: 0, sales: { orders: 4 } });
    expect(withDemo.range.includeDemo).toBe(true);
  });

  it("is empty for a quiet period", async () => {
    const r = await report("2026-09-01", "2026-09-30");
    expect(r.sales).toMatchObject({ orders: 0, totalCents: 0, averageCents: null });
    expect(r.days).toHaveLength(30);
    expect(r.refunds.count).toBe(0);
  });

  it("is for managers and above, with a valid period", async () => {
    for (const actor of [staff, lead])
      expect(await failure(getSalesReport(db, actor, { from: MON, to: MON }))).toBe("forbidden");
    expect(await failure(getSalesReport(db, null, { from: MON, to: MON }))).toBe("unauthenticated");
    for (const range of [{ from: TUE, to: MON }, { from: "2025-01-01", to: MON }, {}])
      expect(await failure(getSalesReport(db, manager, range))).toBe("validation_failed");
  });
});

describe("loyalty figures", () => {
  it("counts rewards issued, redeemed and still owed, with an estimated liability", async () => {
    const sam = await newCustomer();
    // Five stamps make a free drink.
    expect(
      (
        await adjustLoyalty(
          db,
          lead,
          sam.userId,
          { action: "stamps", stamps: 5, reason: "Carte papier", idempotencyKey: randomUUID() },
          at(`${MON}T09:00`),
        )
      ).rewardsIssued,
    ).toBe(1);
    const freeDrink = await buy(sam, at(`${MON}T10:00`), { useReward: true });
    await adjustLoyalty(
      db,
      lead,
      sam.userId,
      { action: "stamps", stamps: 5, reason: "Carte papier", idempotencyKey: randomUUID() },
      at(`${TUE}T09:00`),
    );
    const value = (await orderRow(freeDrink)).rewardDiscountCents;
    expect(value).toBeGreaterThan(0);

    const r = await report(MON, TUE);
    const stamps = await db
      .select({ s: loyaltyAccounts.stampBalance })
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.isDemo, false));
    expect(r.loyalty).toEqual({
      issued: 2,
      redeemed: 1,
      redeemedValueCents: value,
      revoked: 0,
      outstanding: 1,
      averageRewardCents: value,
      estimatedLiabilityCents: value,
      stampsInProgress: stamps.reduce((s, a) => s + a.s, 0),
    });
    // The free drink is a sale at its discounted price, and shows as one free unit.
    expect(r.sales.rewardDiscountCents).toBe(value);
    expect(r.products[0]).toMatchObject({ freeUnits: 1 });
    expect((await report(TUE)).loyalty).toMatchObject({ issued: 1, redeemed: 0, outstanding: 1 });
  });
});

describe("CSV exports", () => {
  it("exports the period's orders without customer details, and audits it", async () => {
    await week();
    const { fileName, csv } = await exportReportCsv(db, manager, {
      kind: "orders",
      from: MON,
      to: THU,
      locale: "fr",
    });
    expect(fileName).toBe(`commandes_${MON}_${THU}.csv`);
    expect(csv.startsWith("﻿Commande,Payée le,Statut,")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(
      /^[^,]+,2026-10-12 10:00,\w+,2\.00,0\.00,0\.00,2\.00,0\.10,0\.20,0\.00,2\.30,0\.00,fake$/,
    );
    expect(csv).toContain(",2.30,2.30,fake"); // order 3, refunded in full
    expect(csv).not.toMatch(/example\.test|Alex/);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "report.exported"));
    expect(audit).toMatchObject({ actorUserId: manager.userId });
    expect(audit!.metadata).toMatchObject({ kind: "orders", from: MON, to: THU, rows: 4 });
  });

  it("exports days, products and refunds; text can't run as a spreadsheet formula", async () => {
    const { o1 } = await week();
    await complete(o1, at(`${MON}T10:30`));
    await refund(o1, 50, at(`${WED}T15:00`), '=HYPERLINK("http://x","y")');
    const days = await exportReportCsv(db, manager, {
      kind: "days",
      from: MON,
      to: THU,
      locale: "en",
    });
    expect(days.csv.split("\r\n")[0]).toBe(
      "﻿Date,Orders,Sales (goods),GST,QST,Tips,Sales total,Refunds,Net",
    );
    expect(days.csv).toContain(`${WED},0,0.00,0.00,0.00,0.00,0.00,1.50,-1.50`);
    const refundsCsv = (
      await exportReportCsv(db, manager, { kind: "refunds", from: WED, to: WED, locale: "en" })
    ).csv;
    expect(refundsCsv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(refundsCsv).toContain(`${WED} 15:00,`);
    const productsCsv = (
      await exportReportCsv(db, manager, { kind: "products", from: MON, to: THU, locale: "en" })
    ).csv;
    expect(productsCsv).toContain(",5,0,10.00");
  });

  it("refuses staff and invalid requests", async () => {
    expect(await failure(exportReportCsv(db, lead, { kind: "orders", from: MON, to: MON }))).toBe(
      "forbidden",
    );
    expect(
      await failure(exportReportCsv(db, manager, { kind: "everything", from: MON, to: MON })),
    ).toBe("validation_failed");
    expect(
      await failure(exportReportCsv(db, manager, { kind: "orders", from: MON, to: "nope" })),
    ).toBe("validation_failed");
  });
});
