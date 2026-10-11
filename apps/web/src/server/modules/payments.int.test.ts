import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eq,
  orderEvents,
  orders,
  paymentAttempts,
  paymentDisputes,
  paymentEvents,
  payments,
  promotions,
  refunds,
  sql,
  users,
  type CatalogProduct,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import { StripeDouble } from "@/test/stripe-double";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { getProductBySlug } from "./catalog/storefront";
import { quoteCart } from "./ordering/cart-quote";
import { expireStaleOrders } from "./ordering/lifecycle";
import {
  cancelOrderAsCustomer,
  refundOrderAsStaff,
  transitionOrderAsStaff,
} from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { getStaffQueue } from "./ordering/staff-queue";
import { openCheckout, syncCheckout } from "./payments/checkout";
import { orderPaymentSummary, paymentsNeedingAttention } from "./payments/history";
import {
  overridePaymentProviderForTests,
  WebhookSignatureError,
  type VerifiedEvent,
} from "./payments/provider";
import { runPaymentRecovery } from "./payments/recovery";
import { handlePaymentWebhook } from "./payments/webhooks";

/*
 * Payment flows against a scripted Stripe double (src/test/stripe-double.ts). Every "Stripe says"
 * in these tests is the double's answer — they verify OUR reconciliation, idempotency and refund
 * logic, not Stripe itself (see the sandbox checklist in docs/13-payments.md for that).
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let handle: DbHandle;
let db: Database;
let stripe: StripeDouble;
let customer: Actor;
let staff: Actor;
let lead: Actor;
let latte: CatalogProduct;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  overridePaymentProviderForTests("stripe", null);
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
  stripe = new StripeDouble();
  overridePaymentProviderForTests("stripe", stripe);
});

const latteLine = () => ({
  lineId: "l1",
  productId: latte.id,
  variantId: latte.variants[1]!.id, // Large 2,00 $ → total 2,30 $ with taxes
  optionIds: latte.groups
    .flatMap((g) => g.options)
    .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
    .map((o) => o.id),
  quantity: 1,
});

async function place(actor: Actor | null = customer, extra: Record<string, unknown> = {}) {
  const lines = [latteLine()];
  const { quote } = await quoteCart(db, actor, { lines, promoCode: extra.promoCode }, NOW);
  return placeOrder(
    db,
    actor,
    {
      idempotencyKey: randomUUID(),
      lines,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Alex", email: actor ? undefined : "alex@example.test" },
      expectedTotalCents: quote.totalCents,
      locale: "fr-CA",
      ...extra,
    },
    { provider: "stripe", now: NOW },
  );
}

async function checkout(orderId: string, actor: Actor | null = customer, now = NOW) {
  const started = await openCheckout(db, stripe, orderId, {
    locale: "fr",
    guestToken: null,
    userId: actor?.userId ?? null,
    now,
  });
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(paymentAttempts.id, started.attemptId),
  });
  return { ...started, sessionId: attempt!.providerSessionId };
}

let eventCounter = 0;
/** Delivers a (double-)signed webhook, as Stripe would POST it. */
type EventInput = VerifiedEvent extends infer E
  ? E extends unknown
    ? Omit<E, "id"> & { id?: string }
    : never
  : never;
function deliver(event: EventInput, now = NOW) {
  eventCounter += 1;
  return handlePaymentWebhook(
    db,
    "stripe",
    JSON.stringify({ id: `evt_${eventCounter}`, ...event }),
    "valid",
    now,
  );
}
const completed = (sessionId: string) =>
  ({ type: "checkout.session.completed", kind: "checkout", sessionId }) as const;

const orderRow = async (id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const paymentRows = (orderId: string) =>
  db.select().from(payments).where(eq(payments.orderId, orderId));
const refundRows = (orderId: string) =>
  db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(refunds.createdAt);

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

/** A Stripe-paid order (webhook delivered). */
async function paidOrder(actor: Actor | null = customer) {
  const placed = await place(actor);
  const { sessionId } = await checkout(placed.orderId, actor);
  stripe.pay(sessionId);
  await deliver(completed(sessionId));
  return placed;
}

describe("starting a checkout", () => {
  it("creates one hosted page for the exact server total, and reuses it on repeat clicks", async () => {
    const placed = await place();
    const [a, b] = await Promise.all([checkout(placed.orderId), checkout(placed.orderId)]);
    expect(a.url).toBe(b.url);
    expect(stripe.checkoutsCreated).toHaveLength(1);
    expect(stripe.checkoutsCreated[0]).toMatchObject({
      amountCents: 230,
      orderId: placed.orderId,
      locale: "fr",
    });
    expect(stripe.checkoutsCreated[0]!.successUrl).toContain("{CHECKOUT_SESSION_ID}");
    // The order (and its pickup slot) is held while the page can still be paid.
    expect((await orderRow(placed.orderId)).expiresAt!.getTime()).toBeGreaterThan(
      later(30).getTime(),
    );
  });

  it("replaces a page that is about to expire, and closes the old one", async () => {
    const placed = await place();
    const first = await checkout(placed.orderId);
    const second = await checkout(placed.orderId, customer, later(30));
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(stripe.expired).toEqual([first.sessionId]);
  });

  it("refuses orders that can't be paid", async () => {
    const placed = await place();
    await db.transaction((tx) => expireStaleOrders(tx, later(120)));
    expect(await failure(checkout(placed.orderId, customer, later(120)))).toBe("order_expired");
  });

  it("refuses a total below the card minimum (fully discounted orders: see ordering.int.test)", async () => {
    await db
      .update(promotions)
      .set({ isActive: true, kind: "amount_off", value: 180 })
      .where(eq(promotions.code, "DEMO10"));
    // 2,00 $ − 1,80 $ = 0,20 $ + taxes = 0,23 $: below Stripe's 0,50 $ minimum.
    expect(await failure(place(customer, { promoCode: "DEMO10" }))).toBe("below_minimum_charge");
  });
});

describe("payment confirmation", () => {
  it("a returning browser proves nothing: the order is paid only when Stripe says so", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    // Redirect back without paying (e.g. URL typed by hand): Stripe still reports "open".
    expect(await syncCheckout(db, customer, placed.orderId, null, NOW)).toMatchObject({
      state: "pending",
      orderStatus: "awaiting_payment",
    });

    stripe.pay(sessionId);
    expect(await syncCheckout(db, customer, placed.orderId, null, NOW)).toMatchObject({
      state: "paid",
      orderStatus: "paid",
    });
    const [payment] = await paymentRows(placed.orderId);
    expect(payment).toMatchObject({ amountCents: 230, cardBrand: "visa", cardLast4: "4242" });
  });

  it("processes each webhook once, and the same payment once whatever reports it", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    stripe.pay(sessionId);

    const event = { id: "evt_same", ...completed(sessionId) };
    expect(await deliver(event)).toMatchObject({ duplicate: false });
    expect(await deliver(event)).toMatchObject({ duplicate: true }); // Stripe retry
    // A different event and the return page both report the same payment.
    await deliver({
      type: "checkout.session.async_payment_succeeded",
      kind: "checkout",
      sessionId,
    });
    await syncCheckout(db, customer, placed.orderId, null, NOW);

    expect(await paymentRows(placed.orderId)).toHaveLength(1);
    expect((await orderRow(placed.orderId)).status).toBe("paid");
    const inbox = await db.select().from(paymentEvents);
    expect(inbox.map((e) => e.eventId)).toContain("evt_same");
    expect(inbox.filter((e) => e.eventId === "evt_same")).toHaveLength(1);
  });

  it("rejects unsigned or tampered webhooks without recording anything", async () => {
    await expect(
      handlePaymentWebhook(db, "stripe", JSON.stringify(completed("cs_x")), "forged", NOW),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await db.select().from(paymentEvents)).toHaveLength(0);
  });

  it("records webhooks for sessions it doesn't know without acting on them", async () => {
    const before = (await db.select().from(payments)).length; // the demo seed has paid orders
    expect(await deliver(completed("cs_unknown"))).toMatchObject({ note: "unknown_session" });
    expect(await db.select().from(payments)).toHaveLength(before);
  });

  it("a declined card leaves the order unpaid and the same page usable to try again", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    await deliver({
      type: "payment_intent.payment_failed",
      kind: "payment_failed",
      paymentId: "pi_declined",
      orderId: placed.orderId,
      message: "Your card was declined.",
    });
    expect((await orderRow(placed.orderId)).status).toBe("awaiting_payment");
    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, placed.orderId));
    expect(events.map((e) => e.type)).toContain("payment_failed");

    stripe.pay(sessionId);
    await deliver(completed(sessionId));
    expect((await orderRow(placed.orderId)).status).toBe("paid");
  });

  it("a payment that is still settling holds the order, keeps it out of the kitchen, then resolves", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    stripe.pay(sessionId, "processing");
    await deliver(completed(sessionId));

    expect((await orderRow(placed.orderId)).expiresAt).toBeNull(); // never expires while settling
    await db.transaction((tx) => expireStaleOrders(tx, later(24 * 60)));
    expect((await orderRow(placed.orderId)).status).toBe("awaiting_payment");
    const queue = await getStaffQueue(db, staff, NOW);
    expect(queue.orders.map((o) => o.id)).not.toContain(placed.orderId);
    expect(await failure(checkout(placed.orderId))).toBe("payment_processing");

    stripe.pay(sessionId, "paid");
    await deliver({
      type: "checkout.session.async_payment_succeeded",
      kind: "checkout",
      sessionId,
    });
    expect((await orderRow(placed.orderId)).status).toBe("paid");
  });

  it("a settling payment that fails lets the customer pay again", async () => {
    const placed = await place();
    const first = await checkout(placed.orderId);
    stripe.pay(first.sessionId, "processing");
    await deliver(completed(first.sessionId));
    stripe.pay(first.sessionId, "failed");
    await deliver({
      type: "checkout.session.async_payment_failed",
      kind: "checkout",
      sessionId: first.sessionId,
    });
    expect((await orderRow(placed.orderId)).status).toBe("awaiting_payment");
    expect((await orderPaymentSummary(db, placed.orderId)).state).toBe("failed");

    const second = await checkout(placed.orderId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("the order can't be prepared before it is paid", async () => {
    const placed = await place();
    expect(
      await failure(
        transitionOrderAsStaff(
          db,
          staff,
          placed.orderId,
          { to: "accepted", expectedVersion: 0 },
          NOW,
        ),
      ),
    ).not.toBeNull();
    expect((await getStaffQueue(db, staff, NOW)).orders.map((o) => o.id)).not.toContain(
      placed.orderId,
    );
  });
});

describe("money that can't pay for the order is returned automatically", () => {
  it("a payment arriving after the order expired is refunded in full", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    await db.transaction((tx) => expireStaleOrders(tx, later(60)));
    expect((await orderRow(placed.orderId)).status).toBe("expired");

    stripe.pay(sessionId);
    await deliver(completed(sessionId), later(61));
    const [payment] = await paymentRows(placed.orderId);
    expect(payment).toMatchObject({
      reconciliation: "late",
      status: "refunded",
      refundedCents: 230,
    });
    expect(await refundRows(placed.orderId)).toMatchObject([
      { source: "system", status: "succeeded", amountCents: 230 },
    ]);
    expect((await orderRow(placed.orderId)).status).toBe("expired");
  });

  it("a second payment for an already-paid order is refunded, the first stands", async () => {
    const placed = await place();
    const first = await checkout(placed.orderId);
    stripe.pay(first.sessionId); // paid in one tab; webhook not here yet…
    // …while the page in another tab was about to expire and got replaced and paid too.
    const second = await checkout(placed.orderId, customer, later(30));
    stripe.pay(second.sessionId);
    await deliver(completed(first.sessionId), later(30));
    await deliver(completed(second.sessionId), later(30));

    const rows = await paymentRows(placed.orderId);
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.reconciliation === null)).toMatchObject({ status: "succeeded" });
    expect(rows.find((p) => p.reconciliation === "duplicate")).toMatchObject({
      status: "refunded",
    });
    expect((await orderRow(placed.orderId)).status).toBe("paid");
  });

  it("a payment for the wrong amount never pays the order", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    stripe.pay(sessionId, "paid", { amountCents: 100 });
    await deliver(completed(sessionId));
    expect((await orderRow(placed.orderId)).status).toBe("awaiting_payment");
    expect((await paymentRows(placed.orderId))[0]).toMatchObject({
      reconciliation: "amount_mismatch",
      status: "refunded",
    });
  });
});

describe("refunds", () => {
  async function completedOrder() {
    const placed = await paidOrder();
    for (const to of ["accepted", "in_preparation", "ready", "completed"] as const) {
      const { version } = await orderRow(placed.orderId);
      await transitionOrderAsStaff(
        db,
        staff,
        placed.orderId,
        { to, expectedVersion: version },
        NOW,
      );
    }
    return placed;
  }

  it("only shift leads refund; a pending refund settles when Stripe confirms it", async () => {
    const placed = await completedOrder();
    expect(
      await failure(
        refundOrderAsStaff(db, staff, placed.orderId, { amountCents: 50, reason: "cold" }, NOW),
      ),
    ).toBe("forbidden");

    stripe.refundStatus = "pending";
    const result = await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 100, reason: "Drink was cold" },
      NOW,
    );
    expect(result).toMatchObject({ status: "completed", refundStatus: "pending" });
    const [pending] = await refundRows(placed.orderId);
    expect(pending).toMatchObject({
      status: "pending",
      requestedByUserId: lead.userId,
      source: "staff",
    });

    stripe.setRefund(pending!.providerRefundId!, { status: "succeeded" });
    await deliver({ type: "refund.updated", kind: "refund", refundId: pending!.providerRefundId! });
    expect((await orderRow(placed.orderId)).status).toBe("partially_refunded");
    expect((await paymentRows(placed.orderId))[0]).toMatchObject({
      status: "partially_refunded",
      refundedCents: 100,
    });
    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, placed.orderId));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["refund_requested", "refund_recorded"]),
    );
  });

  it("pending refunds count, so two refunds can't add up to more than was paid", async () => {
    const placed = await completedOrder();
    stripe.refundStatus = "pending";
    const results = await Promise.allSettled([
      refundOrderAsStaff(db, lead, placed.orderId, { amountCents: 200, reason: "first" }, NOW),
      refundOrderAsStaff(db, lead, placed.orderId, { amountCents: 200, reason: "second" }, NOW),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await refundRows(placed.orderId)).toHaveLength(1);
  });

  it("an interrupted refund call is retried with the same idempotency key — refunded once", async () => {
    const placed = await completedOrder();
    stripe.refundFailures = 1; // Stripe created it, but the answer never arrived
    const result = await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 230, reason: "Wrong order" },
      NOW,
    );
    expect(result.refundStatus).toBe("pending");
    expect((await refundRows(placed.orderId))[0]).toMatchObject({
      status: "pending",
      failureReason: "provider_unreachable",
    });

    const summary = await runPaymentRecovery(db, later(5));
    expect(summary.refundsSubmitted).toBe(1);
    expect(stripe.refundCalls).toHaveLength(2);
    expect(new Set(stripe.refundCalls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(stripe.refundsCreated).toBe(1);
    expect((await orderRow(placed.orderId)).status).toBe("refunded");
  });

  it("a refund Stripe can't complete is flagged for staff and changes nothing", async () => {
    const placed = await completedOrder();
    stripe.refundStatus = "failed";
    await refundOrderAsStaff(
      db,
      lead,
      placed.orderId,
      { amountCents: 230, reason: "Wrong order" },
      NOW,
    );
    expect((await refundRows(placed.orderId))[0]).toMatchObject({ status: "failed" });
    expect((await orderRow(placed.orderId)).status).toBe("completed");
    const attention = await paymentsNeedingAttention(db, lead);
    expect(attention.map((a) => a.kind)).toContain("refund_failed");
  });

  it("a refund made in the Stripe dashboard is recorded in the audit trail", async () => {
    const placed = await completedOrder();
    const [payment] = await paymentRows(placed.orderId);
    const outside = stripe.dashboardRefund(payment!.providerPaymentId, 230);
    await deliver({ type: "refund.created", kind: "refund", refundId: outside.refundId });
    expect((await refundRows(placed.orderId))[0]).toMatchObject({
      source: "provider",
      status: "succeeded",
      requestedByUserId: null,
    });
    expect((await orderRow(placed.orderId)).status).toBe("refunded");
  });

  it("cancelling a paid order refunds it; cancelling an unpaid one closes its payment page", async () => {
    const paid = await paidOrder();
    expect((await cancelOrderAsCustomer(db, customer, paid.orderId, null, NOW)).status).toBe(
      "refunded",
    );
    expect((await refundRows(paid.orderId))[0]).toMatchObject({ source: "customer_cancel" });

    const unpaid = await place();
    const { sessionId } = await checkout(unpaid.orderId);
    await cancelOrderAsCustomer(db, customer, unpaid.orderId, null, NOW);
    expect(stripe.expired).toContain(sessionId);
  });
});

describe("disputes and recovery", () => {
  it("records a chargeback and its updates for staff follow-up", async () => {
    const placed = await paidOrder();
    const [payment] = await paymentRows(placed.orderId);
    const dispute = (status: string) => ({
      type: status === "needs_response" ? "charge.dispute.created" : "charge.dispute.updated",
      kind: "dispute" as const,
      dispute: {
        disputeId: "dp_1",
        paymentId: payment!.providerPaymentId,
        amountCents: 230,
        reason: "fraudulent",
        status,
        evidenceDueBy: later(7 * 24 * 60),
      },
    });
    await deliver(dispute("needs_response"));
    expect((await paymentsNeedingAttention(db, lead)).map((a) => a.kind)).toContain("dispute_open");
    await deliver(dispute("won"));
    const rows = await db.select().from(paymentDisputes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "won", orderId: placed.orderId });
    expect((await orderRow(placed.orderId)).status).toBe("paid"); // the order itself is untouched
  });

  it("the recovery job confirms a payment whose webhook never arrived", async () => {
    const placed = await place();
    const { sessionId } = await checkout(placed.orderId);
    stripe.pay(sessionId);
    const summary = await runPaymentRecovery(db, later(3));
    expect(summary.checkoutsChecked).toBe(1);
    expect((await orderRow(placed.orderId)).status).toBe("paid");
  });

  it("shows the customer what was paid and refunded", async () => {
    const placed = await paidOrder();
    const summary = await orderPaymentSummary(db, placed.orderId);
    expect(summary).toMatchObject({
      state: "paid",
      paid: { amountCents: 230, cardBrand: "visa", cardLast4: "4242", provider: "stripe" },
      refunds: [],
    });
  });
});
