import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  modifierOptions,
  orders,
  products,
  sql,
  stockMovements,
  users,
  type CatalogProduct,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { getPublishedMenu } from "./catalog/menu";
import { getProductBySlug } from "./catalog/storefront";
import { getStockHistory, setStock } from "./inventory/stock";
import { quoteCart } from "./ordering/cart-quote";
import { expireStaleOrders } from "./ordering/lifecycle";
import { transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { getAvailabilityBoard, getStaffQueue } from "./ordering/staff-queue";
import { simulateFakePayment } from "./payments/checkout";

/*
 * Inventory against a real database: auto-86 at zero, stock taken when an order is placed (never
 * below zero, even with simultaneous orders), given back exactly once when an order is stopped
 * before preparation, and staff counts recorded in the ledger and the audit log.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const opts = { provider: "fake" as const, now: NOW };

let handle: DbHandle;
let db: Database;
let customer: Actor;
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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events restart identity cascade`,
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
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

const optionId = (nameEn: string) =>
  latte.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
const latteLine = (quantity = 1, milk = "Whole milk") => ({
  lineId: randomUUID(),
  productId: latte.id,
  variantId: latte.variants[1]!.id,
  optionIds: [optionId("Hot"), optionId(milk)],
  quantity,
});

async function orderInput(lines = [latteLine()]) {
  const quote = await quoteCart(db, customer, { lines }, NOW);
  return {
    idempotencyKey: randomUUID(),
    lines,
    fulfilment: { method: "pickup", when: { kind: "asap" } },
    contact: { name: "Alex" },
    expectedTotalCents: quote.quote.totalCents,
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

const count = async (table: "product" | "option", id: string) => {
  const t = table === "product" ? products : modifierOptions;
  const [row] = await db.select({ n: t.stockQuantity }).from(t).where(eq(t.id, id));
  return row?.n;
};
const ledger = (orderId: string) =>
  db.select().from(stockMovements).where(eq(stockMovements.orderId, orderId));

async function paidOrder(lines = [latteLine()]) {
  const placed = await placeOrder(db, customer, await orderInput(lines), opts);
  await simulateFakePayment(db, placed.orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: customer.userId,
    now: NOW,
  });
  return placed.orderId;
}

async function moveTo(orderId: string, to: string, reason?: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  // Cancelling needs a shift lead; moving an order along, any staff member.
  return transitionOrderAsStaff(
    db,
    to === "cancelled" ? lead : staff,
    orderId,
    { to, reason, expectedVersion: order!.version },
    NOW,
  );
}

describe("auto-86", () => {
  it("a product counted down to zero is sold out on the menu and can't be quoted", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 0 });
    const listed = (await getPublishedMenu(db, NOW))
      .flatMap((c) => c.products)
      .find((p) => p.id === latte.id);
    expect(listed).toMatchObject({ availability: "sold_out", unavailableReason: "sold_out" });
    const quote = await quoteCart(db, customer, { lines: [latteLine()] }, NOW);
    expect(quote.quote.lines[0]?.issues.map((i) => i.code)).toContain("product_unavailable");
  });

  it("an option at zero (oat milk) is sold out while the drink stays on sale", async () => {
    await setStock(db, staff, { target: "option", id: optionId("Oat beverage"), quantity: 0 });
    const quote = await quoteCart(db, customer, { lines: [latteLine(1, "Oat beverage")] }, NOW);
    expect(quote.quote.lines[0]?.issues.map((i) => i.code)).toContain("option_unavailable");
    const plain = await quoteCart(db, customer, { lines: [latteLine()] }, NOW);
    expect(plain.quote.canCheckout).toBe(true);
  });
});

describe("taking stock", () => {
  it("placing an order takes its product and options, and writes the ledger", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 10 });
    await setStock(db, staff, { target: "option", id: optionId("Oat beverage"), quantity: 5 });
    const placed = await placeOrder(
      db,
      customer,
      await orderInput([latteLine(2, "Oat beverage"), latteLine(1)]),
      opts,
    );
    expect(await count("product", latte.id)).toBe(7);
    expect(await count("option", optionId("Oat beverage"))).toBe(3);
    // Untracked options (hot, whole milk) are left alone.
    expect(await count("option", optionId("Whole milk"))).toBeNull();
    const moves = await ledger(placed.orderId);
    expect(moves.map((m) => [m.reason, m.delta, m.quantityAfter]).sort()).toEqual(
      [
        ["sale", -3, 7],
        ["sale", -2, 3],
      ].sort(),
    );
  });

  it("asks for more than is left: the quote says how many remain and the order is refused", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 2 });
    const quote = await quoteCart(db, customer, { lines: [latteLine(3)] }, NOW);
    expect(quote.quote.lines[0]?.issues).toContainEqual({
      code: "insufficient_stock",
      ref: latte.id,
      available: 2,
    });
    const input = await orderInput([latteLine(3)]);
    expect(await failure(placeOrder(db, customer, input, opts))).toBe("cart_invalid");
    expect(await count("product", latte.id)).toBe(2);
  });

  it("simultaneous orders never take more than is left", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 3 });
    const inputs = await Promise.all(Array.from({ length: 6 }, () => orderInput()));
    const results = await Promise.all(
      inputs.map((input) => failure(placeOrder(db, customer, input, opts))),
    );
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r !== null).every((r) => /stock|cart_invalid/.test(r))).toBe(true);
    expect(await count("product", latte.id)).toBe(0);
  });
});

describe("giving stock back", () => {
  beforeEach(async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 5 });
  });

  it("an unpaid order that expires gives its stock back, once", async () => {
    const placed = await placeOrder(db, customer, await orderInput([latteLine(2)]), opts);
    expect(await count("product", latte.id)).toBe(3);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await db.transaction((tx) => expireStaleOrders(tx, later));
    await db.transaction((tx) => expireStaleOrders(tx, later));
    expect(await count("product", latte.id)).toBe(5);
    const net = (await ledger(placed.orderId)).reduce((s, m) => s + m.delta, 0);
    expect(net).toBe(0);
  });

  it("a paid order cancelled before preparation gives its stock back", async () => {
    const orderId = await paidOrder([latteLine(2)]);
    await moveTo(orderId, "cancelled", "Out of milk");
    expect(await count("product", latte.id)).toBe(5);
  });

  it("an order cancelled while being made keeps its stock used", async () => {
    const orderId = await paidOrder([latteLine(2)]);
    await moveTo(orderId, "accepted");
    await moveTo(orderId, "in_preparation");
    await moveTo(orderId, "cancelled", "Customer left");
    expect(await count("product", latte.id)).toBe(3);
  });

  it("stock given back while tracking was off closes the ledger without inventing a count", async () => {
    const placed = await placeOrder(db, customer, await orderInput([latteLine(2)]), opts);
    await setStock(db, staff, { target: "product", id: latte.id, quantity: null });
    await db.transaction((tx) => expireStaleOrders(tx, new Date(NOW.getTime() + 3_600_000)));
    expect(await count("product", latte.id)).toBeNull();
    const release = (await ledger(placed.orderId)).find((m) => m.reason === "release");
    expect(release).toMatchObject({ delta: 2, quantityAfter: null });
  });
});

describe("staff counts", () => {
  it("staff set and clear counts; each change is in the ledger and the audit log", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 12 });
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 9 });
    await setStock(db, staff, { target: "product", id: latte.id, quantity: null });
    const moves = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.productId, latte.id))
      .orderBy(stockMovements.createdAt);
    expect(moves.map((m) => [m.reason, m.delta, m.quantityAfter])).toEqual([
      ["restock", 12, 12],
      ["adjustment", -3, 9],
      ["adjustment", -9, null],
    ]);
    expect(moves.every((m) => m.actorUserId === staff.userId)).toBe(true);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "catalog.product_stock_set"));
    expect(audits).toHaveLength(3);
    const board = await getAvailabilityBoard(db, staff);
    expect(board.products.find((p) => p.id === latte.id)?.stockQuantity).toBeNull();
  });

  it("customers can't set stock, and counts must be whole and not negative", async () => {
    expect(
      await failure(setStock(db, customer, { target: "product", id: latte.id, quantity: 5 })),
    ).toBe("forbidden");
    expect(
      await failure(setStock(db, staff, { target: "product", id: latte.id, quantity: -1 })),
    ).toBe("validation_failed");
    expect(
      await failure(setStock(db, staff, { target: "product", id: randomUUID(), quantity: 1 })),
    ).toBe("not_found");
  });
});

describe("low-stock alerts and history", () => {
  it("items at or under their threshold, and items at zero, are on the staff queue", async () => {
    await setStock(db, staff, {
      target: "product",
      id: latte.id,
      quantity: 5,
      lowStockThreshold: 3,
    });
    await setStock(db, staff, { target: "option", id: optionId("Oat beverage"), quantity: 0 });
    expect((await getStaffQueue(db, staff, NOW)).stockAlerts).toEqual([
      expect.objectContaining({ target: "option", nameEn: "Oat beverage", stock: 0, level: "out" }),
    ]);

    // Two lattes sold: 3 left, at the threshold.
    await placeOrder(db, customer, await orderInput([latteLine(2)]), opts);
    const alerts = (await getStaffQueue(db, staff, NOW)).stockAlerts;
    expect(alerts.map((a) => [a.id, a.stock, a.level])).toEqual([
      [optionId("Oat beverage"), 0, "out"],
      [latte.id, 3, "low"],
    ]);
  });

  it("changing only the threshold is audited but leaves the ledger alone", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 8 });
    const result = await setStock(db, staff, {
      target: "product",
      id: latte.id,
      quantity: 8,
      lowStockThreshold: 2,
    });
    expect(result).toMatchObject({ stockQuantity: 8, lowStockThreshold: 2 });
    // Omitted threshold: unchanged.
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 9 });
    const board = await getAvailabilityBoard(db, staff);
    expect(board.products.find((p) => p.id === latte.id)).toMatchObject({
      stockQuantity: 9,
      lowStockThreshold: 2,
    });
    const moves = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.productId, latte.id));
    expect(moves.map((m) => m.delta).sort()).toEqual([1, 8]);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "catalog.product_stock_set"));
    expect(audits.map((a) => a.metadata)).toContainEqual({
      from: 8,
      to: 8,
      thresholdFrom: null,
      thresholdTo: 2,
    });
  });

  it("history lists the latest movements with order numbers; staff names, never customers'", async () => {
    await setStock(db, staff, { target: "product", id: latte.id, quantity: 6 });
    const placed = await placeOrder(db, customer, await orderInput([latteLine(2)]), opts);
    const history = await getStockHistory(db, staff, { target: "product", id: latte.id });
    expect(history.map((h) => [h.reason, h.delta, h.quantityAfter, h.orderNumber])).toEqual([
      ["sale", -2, 4, placed.number],
      ["restock", 6, 6, null],
    ]);
    expect(history[0]?.actorName).toBeNull();
    expect(history[1]?.actorName).toBeTruthy();

    expect(await failure(getStockHistory(db, customer, { target: "product", id: latte.id }))).toBe(
      "forbidden",
    );
    expect(await failure(getStockHistory(db, staff, { target: "x", id: "nope" }))).toBe(
      "validation_failed",
    );
  });
});
