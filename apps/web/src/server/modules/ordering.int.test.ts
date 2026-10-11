import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eq,
  loyaltyAccounts,
  orderEvents,
  orderItems,
  orders,
  paymentAttempts,
  payments,
  promotions,
  refunds,
  rewards,
  sql,
  storeSettings,
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
import { getSavedCart, saveCart } from "./customer/cart";
import { provisionAccount } from "./identity/provisioning";
import { quoteCart } from "./ordering/cart-quote";
import { getOrderDetail } from "./ordering/customer-orders";
import {
  cancelOrderAsCustomer,
  refundOrderAsStaff,
  transitionOrderAsStaff,
  updateOrderAsCustomer,
  updateStaffNotes,
} from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { getStaffQueue, setItemAvailability, setOrderingPause } from "./ordering/staff-queue";
import { applyCheckout, simulateFakePayment } from "./payments/checkout";

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

const opt = (p: CatalogProduct, nameEn: string) =>
  p.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
const latteLine = (lineId = "l1", quantity = 1) => ({
  lineId,
  productId: latte.id,
  variantId: latte.variants[1]!.id, // Large 2,00 $
  optionIds: [opt(latte, "Hot"), opt(latte, "Whole milk")],
  quantity,
});

type Lines = Array<ReturnType<typeof latteLine> & { notes?: string }>;

async function orderInput(
  actor: Actor | null,
  overrides: Record<string, unknown> = {},
  lines: Lines = [latteLine()],
) {
  const quote = await quoteCart(
    db,
    actor,
    { lines, useReward: overrides.useReward, promoCode: overrides.promoCode },
    NOW,
  );
  return {
    idempotencyKey: randomUUID(),
    lines,
    fulfilment: { method: "pickup", when: { kind: "asap" } },
    contact: { name: "Alex", email: actor ? undefined : "alex@example.test" },
    expectedTotalCents: quote.quote.totalCents,
    locale: "fr-CA",
    ...overrides,
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

/** Pays through the development simulator (same reconciliation path as a verified Stripe payment). */
async function payFor(orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  return simulateFakePayment(db, orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: order!.userId,
    now: NOW,
  });
}

describe("order creation", () => {
  it("creates a guest order from ids with server prices, snapshots, a unique number and history", async () => {
    const input = await orderInput(null, {}, [{ ...latteLine(), notes: "extra hot" }]);
    const placed = await placeOrder(db, null, input, opts);
    expect(placed).toMatchObject({ status: "awaiting_payment", totalCents: 230, replayed: false });
    expect(placed.number).toMatch(/^1012-\d{3}$/);
    expect(placed.guestToken).toBeTruthy();

    const [order] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order).toMatchObject({
      subtotalCents: 200,
      gstCents: 10,
      qstCents: 20,
      totalCents: 230,
      guestEmail: "alex@example.test",
    });
    expect(order!.guestAccessTokenHash).not.toBe(placed.guestToken); // only the hash is stored
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    expect(items[0]).toMatchObject({
      productNameFr: "[DÉMO] Latte",
      variantNameEn: "Large",
      unitPriceCents: 200,
      notes: "extra hot",
    });
    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, placed.orderId));
    expect(events.map((e) => e.type)).toEqual(["created"]);
  });

  it("purchase-time snapshots don't change when the menu price changes later", async () => {
    const placed = await placeOrder(db, customer, await orderInput(customer), opts);
    await db.execute(
      sql`update product_variants set price_cents = 999 where id = ${latte.variants[1]!.id}`,
    );
    const detail = await getOrderDetail(db, customer, placed.orderId);
    expect(detail.items[0]?.unitPriceCents).toBe(200);
    expect(detail.totals.totalCents).toBe(230);
  });

  it("never lets the client set the total: a manipulated expected total is refused", async () => {
    const input = await orderInput(null);
    expect(await failure(placeOrder(db, null, { ...input, expectedTotalCents: 1 }, opts))).toBe(
      "price_changed",
    );
    // Extra fields (prices, totals) in lines are ignored by validation.
    const tampered = { ...input, lines: [{ ...latteLine(), unitPriceCents: 1, priceCents: 1 }] };
    expect((await placeOrder(db, null, tampered, opts)).totalCents).toBe(230);
  });

  it("returns the same order for a repeated request and refuses a reused key with a different body", async () => {
    const input = await orderInput(customer);
    const first = await placeOrder(db, customer, input, opts);
    const again = await placeOrder(db, customer, input, opts);
    expect(again).toMatchObject({ orderId: first.orderId, replayed: true });
    expect(await failure(placeOrder(db, customer, { ...input, notes: "changed" }, opts))).toBe(
      "idempotency_key_reused",
    );
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, input.idempotencyKey));
    expect(rows).toHaveLength(1);
  });

  it("concurrent submissions with the same key create exactly one order", async () => {
    const input = await orderInput(customer);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(db, customer, input, opts)),
    );
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, input.idempotencyKey));
    expect(rows).toHaveLength(1);
  });

  it("concurrent customers can't over-fill a pickup slot", async () => {
    await db.update(storeSettings).set({ maxOrdersPerSlot: 1 });
    const inputs = await Promise.all([orderInput(null), orderInput(null), orderInput(null)]);
    const results = await Promise.allSettled(inputs.map((i) => placeOrder(db, null, i, opts)));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r.reason as AppError).reason).toMatch(/slot_full|asap_unavailable/);
    }
  });

  it("refuses orders while paused, for unoffered times, and without a payment provider", async () => {
    const input = await orderInput(null);
    expect(await failure(placeOrder(db, null, input, { provider: "none", now: NOW }))).toBe(
      "payments_unavailable",
    );
    const offHours = {
      ...input,
      fulfilment: { method: "pickup", when: { kind: "scheduled", at: "2026-10-12T23:00:00.000Z" } },
    };
    expect(await failure(placeOrder(db, null, offHours, opts))).toBe("slot_unavailable");
    await setOrderingPause(db, lead, { minutes: 30 }, NOW);
    expect(
      await failure(placeOrder(db, null, { ...input, idempotencyKey: randomUUID() }, opts)),
    ).toBe("ordering_unavailable");
  });

  it("checks schedules and temporary disabling at the pickup time", async () => {
    const bowl = (await getProductBySlug(db, "demo-breakfast-bowl"))!;
    const bowlLine = [
      {
        lineId: "b",
        productId: bowl.id,
        variantId: bowl.variants[0]!.id,
        optionIds: [],
        quantity: 1,
      },
    ];
    const asap = await orderInput(null, {}, bowlLine);
    expect((await placeOrder(db, null, asap, opts)).status).toBe("awaiting_payment"); // 10:00, window until 11:00

    const afternoon = {
      ...(await orderInput(null, {}, bowlLine)),
      fulfilment: { method: "pickup", when: { kind: "scheduled", at: "2026-10-12T17:00:00.000Z" } },
    };
    expect(await failure(placeOrder(db, null, afternoon, opts))).toBe("cart_invalid");

    await setItemAvailability(
      db,
      staff,
      { target: "product", id: latte.id, state: "disabled_for", minutes: 60 },
      NOW,
    );
    expect(await failure(placeOrder(db, null, await orderInput(null), opts))).toBe("cart_invalid");
  });
});

describe("payment confirmation", () => {
  it("marks paid once per provider payment and earns stamps once", async () => {
    const placed = await placeOrder(
      db,
      customer,
      await orderInput(customer, {}, [latteLine("l1", 2)]),
      opts,
    );
    const [before] = await db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.userId, customer.userId));

    expect(await payFor(placed.orderId)).toMatchObject({ state: "paid", orderStatus: "paid" });
    // The same provider payment reported again (webhook retry, return page) changes nothing.
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    const attempt = await db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.id, payment!.attemptId!),
    });
    const replay = await applyCheckout(
      db,
      "fake",
      {
        sessionId: attempt!.providerSessionId,
        status: "complete",
        payment: "paid",
        paymentId: payment!.providerPaymentId,
        amountCents: payment!.amountCents,
        currency: "cad",
        orderId: placed.orderId,
        card: null,
      },
      NOW,
    );
    expect(replay.outcome).toBe("duplicate");
    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.orderId, placed.orderId));
    expect(paymentRows).toHaveLength(1);

    const [after] = await db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.userId, customer.userId));
    expect(after!.lifetimeStamps - before!.lifetimeStamps).toBe(2);
  });
});

describe("rewards and promotions under concurrency", () => {
  it("a single free drink can't be used by two simultaneous orders, and is released on cancel", async () => {
    const [a, b] = await Promise.all([
      orderInput(customer, { useReward: true }),
      orderInput(customer, { useReward: true }),
    ]);
    const results = await Promise.allSettled([
      placeOrder(db, customer, a, opts),
      placeOrder(db, customer, b, opts),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as Array<
      PromiseFulfilledResult<{ orderId: string; totalCents: number }>
    >;
    expect(ok).toHaveLength(1);
    expect(ok[0]!.value.totalCents).toBe(0); // large latte free, nothing else
    // Nothing to pay: the order is confirmed at once and the free drink used.
    expect(ok[0]!.value).toMatchObject({ status: "paid" });
    const [reward] = await db.select().from(rewards);
    expect(reward!.status).toBe("redeemed");

    await cancelOrderAsCustomer(db, customer, ok[0]!.value.orderId);
    const [released] = await db.select().from(rewards);
    expect(released!.status).toBe("available");
  });

  it("enforces a promotion's usage limit across simultaneous orders", async () => {
    await db
      .update(promotions)
      .set({ isActive: true, maxRedemptions: 1 })
      .where(eq(promotions.code, "DEMO10"));
    const inputs = await Promise.all([
      orderInput(null, { promoCode: "DEMO10" }),
      orderInput(null, { promoCode: "DEMO10" }),
    ]);
    const results = await Promise.allSettled(inputs.map((i) => placeOrder(db, null, i, opts)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as AppError).reason).toBe("promotion_exhausted");
  });
});

describe("status transitions and policies", () => {
  async function paidOrder(actor: Actor | null = customer) {
    const placed = await placeOrder(db, actor, await orderInput(actor), opts);
    await payFor(placed.orderId);
    return placed;
  }
  const version = async (id: string) =>
    (await db.select().from(orders).where(eq(orders.id, id)))[0]!.version;

  it("follows the kitchen flow and rejects invalid or unauthorized moves", async () => {
    const { orderId } = await paidOrder();
    expect(
      await failure(
        transitionOrderAsStaff(
          db,
          staff,
          orderId,
          { to: "ready", expectedVersion: await version(orderId) },
          NOW,
        ),
      ),
    ).toBe("conflict");
    expect(
      await failure(
        transitionOrderAsStaff(db, customer, orderId, { to: "accepted", expectedVersion: 0 }, NOW),
      ),
    ).toBe("forbidden");
    for (const to of ["accepted", "in_preparation", "ready", "completed"]) {
      await transitionOrderAsStaff(
        db,
        staff,
        orderId,
        { to, expectedVersion: await version(orderId) },
        NOW,
      );
    }
    const detail = await getOrderDetail(db, customer, orderId);
    expect(detail.timeline.map((t) => t.status)).toEqual([
      "awaiting_payment",
      "paid",
      "accepted",
      "in_preparation",
      "ready",
      "completed",
    ]);
  });

  it("two staff tapping the same order at once: one wins, the other gets a conflict", async () => {
    const { orderId } = await paidOrder();
    const v = await version(orderId);
    const results = await Promise.allSettled([
      transitionOrderAsStaff(db, staff, orderId, { to: "accepted", expectedVersion: v }, NOW),
      transitionOrderAsStaff(db, lead, orderId, { to: "accepted", expectedVersion: v }, NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("rejecting a paid order requires a reason and refunds it in full", async () => {
    const { orderId } = await paidOrder();
    expect(
      await failure(
        transitionOrderAsStaff(
          db,
          staff,
          orderId,
          { to: "rejected", expectedVersion: await version(orderId) },
          NOW,
        ),
      ),
    ).toBe("validation_failed");
    const result = await transitionOrderAsStaff(
      db,
      staff,
      orderId,
      { to: "rejected", reason: "Out of oat milk", expectedVersion: await version(orderId) },
      NOW,
    );
    expect(result.status).toBe("refunded");
    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(refundRows).toMatchObject([{ amountCents: 230, status: "succeeded" }]);
  });

  it("customers can cancel until accepted (paid orders are refunded), not after", async () => {
    const early = await paidOrder();
    expect((await cancelOrderAsCustomer(db, customer, early.orderId, null, NOW)).status).toBe(
      "refunded",
    );
    // The customer's own cancellation carries no café reason (it stays in the event history).
    const cancelled = await db.query.orders.findFirst({ where: eq(orders.id, early.orderId) });
    expect(cancelled?.cancellationReason).toBeNull();

    const late = await paidOrder();
    await transitionOrderAsStaff(
      db,
      staff,
      late.orderId,
      { to: "accepted", expectedVersion: await version(late.orderId) },
      NOW,
    );
    expect(await failure(cancelOrderAsCustomer(db, customer, late.orderId, null, NOW))).toBe(
      "cancel_not_allowed",
    );
    const stranger = await newCustomer();
    expect(await failure(cancelOrderAsCustomer(db, stranger, late.orderId, null, NOW))).toBe(
      "not_found",
    );
  });

  it("partial refunds by a shift lead never exceed what was paid", async () => {
    const { orderId } = await paidOrder();
    for (const to of ["accepted", "in_preparation", "ready", "completed"]) {
      await transitionOrderAsStaff(
        db,
        staff,
        orderId,
        { to, expectedVersion: await version(orderId) },
        NOW,
      );
    }
    expect(
      await failure(
        refundOrderAsStaff(db, staff, orderId, { amountCents: 50, reason: "cold" }, NOW),
      ),
    ).toBe("forbidden");
    expect(
      (await refundOrderAsStaff(db, lead, orderId, { amountCents: 50, reason: "cold drink" }, NOW))
        .status,
    ).toBe("partially_refunded");
    expect(
      await failure(
        refundOrderAsStaff(db, lead, orderId, { amountCents: 500, reason: "too much" }, NOW),
      ),
    ).toBe("validation_failed");
    expect(
      (await refundOrderAsStaff(db, lead, orderId, { amountCents: 180, reason: "rest" }, NOW))
        .status,
    ).toBe("refunded");
  });

  it("unpaid orders expire and free their slot", async () => {
    await db.update(storeSettings).set({ maxOrdersPerSlot: 1 });
    const placed = await placeOrder(db, null, await orderInput(null), opts);
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await getStaffQueue(db, staff, later);
    const [order] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order!.status).toBe("expired");
  });

  it("customers may move a scheduled pickup within policy, not an ASAP order", async () => {
    const scheduled = await placeOrder(
      db,
      customer,
      {
        ...(await orderInput(customer)),
        fulfilment: {
          method: "pickup",
          when: { kind: "scheduled", at: "2026-10-12T16:00:00.000Z" },
        },
      },
      opts,
    );
    const moved = await updateOrderAsCustomer(
      db,
      customer,
      scheduled.orderId,
      { scheduledFor: "2026-10-12T16:30:00.000Z", notes: "door" },
      null,
      NOW,
    );
    expect(moved.scheduledFor?.toISOString()).toBe("2026-10-12T16:30:00.000Z");
    const asap = await placeOrder(db, customer, await orderInput(customer), opts);
    expect(
      await failure(updateOrderAsCustomer(db, customer, asap.orderId, { notes: "x" }, null, NOW)),
    ).toBe("modify_not_allowed");
  });

  it("guests reach their order only with its token; staff notes stay internal", async () => {
    const placed = await placeOrder(db, null, await orderInput(null), opts);
    expect(await failure(getOrderDetail(db, null, placed.orderId, "wrong"))).toBe("not_found");
    expect((await getOrderDetail(db, null, placed.orderId, placed.guestToken)).number).toBe(
      placed.number,
    );

    await payFor(placed.orderId);
    await updateStaffNotes(db, staff, placed.orderId, { staffNotes: "Regular — double cup" });
    const queue = await getStaffQueue(db, staff, NOW);
    expect(queue.orders.find((o) => o.id === placed.orderId)).toMatchObject({
      staffNotes: "Regular — double cup",
      actions: ["accepted", "rejected"],
    });
    const guestView = await getOrderDetail(db, null, placed.orderId, placed.guestToken);
    expect(JSON.stringify(guestView)).not.toContain("double cup");
  });
});

describe("saved carts", () => {
  it("persists a signed-in cart with optimistic versioning and drops malformed data", async () => {
    expect(await getSavedCart(db, customer)).toEqual({ lines: [], version: 0 });
    const saved = await saveCart(db, customer, { lines: [latteLine()] });
    expect(saved.version).toBe(1);
    expect(await failure(saveCart(db, customer, { lines: [], expectedVersion: 0 }))).toBe(
      "cart_version_conflict",
    );
    expect((await saveCart(db, customer, { lines: [], expectedVersion: 1 })).version).toBe(2);
    expect(
      await failure(saveCart(db, customer, { lines: [{ ...latteLine(), quantity: 99 }] })),
    ).toBe("validation_failed");
    expect(await failure(saveCart(db, null, { lines: [] }))).toBe("unauthenticated");
  });
});

async function newCustomer(): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "", email: `${userId}@example.test` });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}
