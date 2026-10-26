import type { orders } from "@ssc/db";
import {
  and,
  eq,
  isNotNull,
  isNull,
  or,
  orderItems,
  payments,
  refunds,
  sql,
  type Database,
  type RefundItem,
  type Tx,
} from "@ssc/db";
import {
  paymentStatusAfterRefunds,
  REFUNDABLE_ORDER_STATUSES,
  refundableCents,
  type OrderStatus,
  type RefundStatus,
} from "@ssc/domain";
import { recordAudit } from "../../audit";
import { AppError, required, unprocessable } from "../../errors";
import { logger } from "../../logger";
import { giftCardRefundedCents, moveGiftCardBalance } from "../gift-cards/ledger";
import { refundedUnits, reverseForRefund } from "../loyalty/earning";
import {
  actorUserId,
  applyTransition,
  lockOrder,
  recordOrderEvent,
  type OrderActor,
} from "../ordering/lifecycle";
import { paymentProvider, type RefundSnapshot } from "./provider";

/*
 * Refunds in three steps, so money and records can never disagree for long:
 *   1. requestRefund — inside the caller's transaction: validates the amount against what is
 *      still refundable (pending refunds included) and records a `pending` refund with who
 *      asked and why.
 *   2. submitRefund — after commit: asks the provider, using the refund id as idempotency key.
 *      If the call fails mid-way the refund stays pending and the recovery job resubmits it;
 *      the provider returns the same refund instead of creating a second one.
 *   3. settleRefund — applies the provider's answer (API response, webhook or status check):
 *      updates the payment's refunded amount and moves the order to (partially_)refunded.
 */

export type RefundSource = "staff" | "customer_cancel" | "system" | "provider";
type PaymentRow = typeof payments.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

const FINAL: readonly RefundStatus[] = ["succeeded", "failed", "cancelled"];

/** The payment that paid for the order (not a late or duplicate one). */
export async function primaryPayment(tx: Tx, orderId: string): Promise<PaymentRow | undefined> {
  const rows = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId)))
    .for("update");
  return rows.find((p) => p.reconciliation === null && p.status !== "failed");
}

/**
 * Records a pending refund (caller holds the order lock). Returns the refund id to submit after
 * the transaction commits.
 */
export async function requestRefund(
  tx: Tx,
  input: {
    payment: PaymentRow;
    orderStatus: OrderStatus;
    amountCents: number;
    reason: string;
    source: RefundSource;
    actor: OrderActor;
    /** Order lines this refund pays back (their stamps are reversed when it succeeds). */
    items?: readonly RefundItem[];
    /** Request time (the recovery job ages refunds by it); defaults to the database clock. */
    now?: Date;
  },
): Promise<string> {
  const { payment, amountCents, reason, source, actor } = input;
  const items = await validRefundItems(tx, payment.orderId, input.items ?? []);
  if (payment.reconciliation === null && !REFUNDABLE_ORDER_STATUSES.includes(input.orderStatus)) {
    // An order still in the kitchen is cancelled instead (which refunds it in full).
    throw unprocessable("refund_not_allowed");
  }
  const existing = await tx
    .select({ amountCents: refunds.amountCents, status: refunds.status })
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id));
  const available = refundableCents(payment.amountCents, existing);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > available) {
    throw new AppError("validation_failed", "Refund amount not available", [
      { path: "amountCents", code: "amount_invalid" },
    ]);
  }
  const [refund] = await tx
    .insert(refunds)
    .values({
      orderId: payment.orderId,
      paymentId: payment.id,
      amountCents,
      reason,
      status: "pending",
      source,
      requestedByUserId: actorUserId(actor),
      items,
      ...(input.now ? { createdAt: input.now } : {}),
    })
    .returning({ id: refunds.id });
  const refundId = required(refund, "refund").id;
  await recordOrderEvent(tx, payment.orderId, "refund_requested", actor, {
    refundId,
    amountCents,
    reason,
    source,
    ...(items.length > 0 ? { items } : {}),
  });
  await recordAudit(tx, {
    actorUserId: actorUserId(actor),
    action: "payment.refund_requested",
    entityType: "order",
    entityId: payment.orderId,
    metadata: { refundId, amountCents, source },
  });
  return refundId;
}

/**
 * Merges duplicate lines and checks each belongs to the order and is not refunded beyond the units
 * bought (refunds that have not failed count).
 */
export async function validRefundItems(
  tx: Tx,
  orderId: string,
  raw: readonly RefundItem[],
): Promise<RefundItem[]> {
  if (raw.length === 0) return [];
  const merged = new Map<string, number>();
  for (const i of raw) merged.set(i.orderItemId, (merged.get(i.orderItemId) ?? 0) + i.quantity);
  const lines = new Map(
    (
      await tx
        .select({ id: orderItems.id, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
    ).map((l) => [l.id, l.quantity]),
  );
  const already = await refundedUnits(tx, orderId);
  for (const [id, qty] of merged) {
    const bought = lines.get(id);
    if (bought === undefined || qty <= 0 || qty + (already.get(id) ?? 0) > bought) {
      throw new AppError("validation_failed", "Refund items invalid", [
        { path: "items", code: "quantity_invalid" },
      ]);
    }
  }
  return [...merged].map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
}

/**
 * Money given back for the order itself, by any means: succeeded refunds of its own payment (not
 * of late or duplicate money) plus refunds to its gift card.
 */
export async function orderRefundedCents(tx: Tx, orderId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .leftJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(refunds.orderId, orderId),
        eq(refunds.status, "succeeded"),
        or(isNotNull(refunds.giftCardId), isNull(payments.reconciliation)),
      ),
    );
  return required(row, "sum").cents;
}

/**
 * After a refund of the order's own money succeeded (by card or to its gift card): the refunded
 * drinks' stamps go first, then the order becomes refunded once everything paid is given back,
 * partially refunded until then. Caller holds the order lock and passes the current row.
 */
async function applyRefundToOrder(
  tx: Tx,
  order: OrderRow,
  refund: { id: string; reason: string },
  now: Date,
): Promise<void> {
  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) return;
  await reverseForRefund(tx, order, refund.id, now);
  const refunded = await orderRefundedCents(tx, order.id);
  await applyTransition(
    tx,
    order,
    refunded >= order.totalCents ? "refunded" : "partially_refunded",
    { kind: "system" },
    { reason: refund.reason, now },
  );
}

/** What can still be given back for an order: by card (its payment) and to its gift card. */
export async function refundableForOrder(
  tx: Tx,
  order: OrderRow,
): Promise<{ payment: PaymentRow | undefined; cardCents: number; giftCardCents: number }> {
  const payment = await primaryPayment(tx, order.id);
  let cardCents = 0;
  if (payment) {
    const existing = await tx
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(eq(refunds.paymentId, payment.id));
    cardCents = refundableCents(payment.amountCents, existing);
  }
  const giftCardCents = order.giftCardId
    ? Math.max(0, order.giftCardCents - (await giftCardRefundedCents(tx, order.id)))
    : 0;
  return { payment, cardCents, giftCardCents };
}

/**
 * Gives money back to the gift card that paid part of the order. Settled at once (no provider):
 * the refund row is recorded as succeeded with the card credit, in the caller's transaction on the
 * locked order. Returns the refund id.
 */
export async function refundToGiftCard(
  tx: Tx,
  input: {
    orderId: string;
    amountCents: number;
    reason: string;
    source: RefundSource;
    actor: OrderActor;
    items?: readonly RefundItem[];
    now: Date;
  },
): Promise<string> {
  const order = required(await lockOrder(tx, input.orderId), "order");
  if (!order.giftCardId) throw unprocessable("not_paid");
  if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) throw unprocessable("refund_not_allowed");
  const { giftCardCents: available } = await refundableForOrder(tx, order);
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > available
  ) {
    throw new AppError("validation_failed", "Refund amount not available", [
      { path: "amountCents", code: "amount_invalid" },
    ]);
  }
  const items = await validRefundItems(tx, order.id, input.items ?? []);
  const [refund] = await tx
    .insert(refunds)
    .values({
      orderId: order.id,
      giftCardId: order.giftCardId,
      amountCents: input.amountCents,
      reason: input.reason,
      status: "succeeded",
      source: input.source,
      requestedByUserId: actorUserId(input.actor),
      items,
      submittedAt: input.now,
      settledAt: input.now,
    })
    .returning({ id: refunds.id });
  const refundId = required(refund, "refund").id;
  await moveGiftCardBalance(tx, order.giftCardId, {
    kind: "refund",
    deltaCents: input.amountCents,
    orderId: order.id,
    refundId,
    actorUserId: actorUserId(input.actor),
    note: input.reason,
  });
  const details = {
    refundId,
    amountCents: input.amountCents,
    reason: input.reason,
    giftCard: true,
  };
  await recordOrderEvent(tx, order.id, "refund_requested", input.actor, {
    ...details,
    source: input.source,
  });
  await recordOrderEvent(tx, order.id, "refund_recorded", { kind: "system" }, details);
  await recordAudit(tx, {
    actorUserId: actorUserId(input.actor),
    action: "payment.refund_requested",
    entityType: "order",
    entityId: order.id,
    metadata: { refundId, amountCents: input.amountCents, source: input.source, giftCard: true },
  });
  await applyRefundToOrder(tx, order, { id: refundId, reason: input.reason }, input.now);
  return refundId;
}

/**
 * Sends a pending refund to the provider and settles it with the answer. Safe to call again
 * (recovery job): the refund id is the idempotency key, and settled refunds are left alone.
 */
export async function submitRefund(
  db: Database,
  refundId: string,
  now = new Date(),
): Promise<RefundStatus> {
  const row = await db.query.refunds.findFirst({
    where: eq(refunds.id, refundId),
    with: { payment: true },
  });
  if (!row) throw new Error(`Unknown refund ${refundId}`);
  if (row.status !== "pending" || !row.payment) return row.status;
  if (row.providerRefundId) return "pending"; // submitted; waiting for the provider's webhook

  let snapshot: RefundSnapshot;
  try {
    snapshot = await paymentProvider(row.payment.provider).refund({
      paymentId: row.payment.providerPaymentId,
      amountCents: row.amountCents,
      idempotencyKey: row.id,
      localRefundId: row.id,
      reason:
        row.payment.reconciliation === "duplicate"
          ? "duplicate"
          : row.source === "customer_cancel"
            ? "requested_by_customer"
            : null,
    });
  } catch (error) {
    // Unknown outcome (timeout, network): stay pending; the recovery job retries with the same key.
    logger().warn({ err: error, refundId }, "refund submission failed; will retry");
    await db
      .update(refunds)
      .set({ failureReason: "provider_unreachable" })
      .where(eq(refunds.id, refundId));
    return "pending";
  }
  return settleRefund(db, { ...snapshot, localRefundId: row.id }, now);
}

/**
 * Applies the provider's view of a refund. Idempotent. A refund the app didn't create (issued from
 * the provider's dashboard) is recorded too, so the audit trail is complete.
 */
export async function settleRefund(
  db: Database,
  snapshot: RefundSnapshot,
  now = new Date(),
): Promise<RefundStatus> {
  return db.transaction((tx) => settleRefundInTx(tx, snapshot, now));
}

/** settleRefund inside the caller's transaction (webhook processing). */
export async function settleRefundInTx(
  tx: Tx,
  snapshot: RefundSnapshot,
  now: Date,
): Promise<RefundStatus> {
  const find = () =>
    tx.query.refunds.findFirst({
      where: snapshot.localRefundId
        ? eq(refunds.id, snapshot.localRefundId)
        : eq(refunds.providerRefundId, snapshot.refundId),
    });
  let row = await find();
  const system: OrderActor = { kind: "system" };

  if (!row) {
    if (!snapshot.paymentId) return snapshot.status;
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, snapshot.paymentId));
    if (!payment) return snapshot.status; // not one of ours; the event stays in the inbox
    await lockOrder(tx, payment.orderId);
    const [created] = await tx
      .insert(refunds)
      .values({
        orderId: payment.orderId,
        paymentId: payment.id,
        amountCents: snapshot.amountCents,
        reason: "Issued from the payment provider's dashboard",
        status: "pending",
        source: "provider",
        providerRefundId: snapshot.refundId,
        submittedAt: now,
      })
      .returning();
    row = required(created, "refund");
    await recordOrderEvent(tx, payment.orderId, "refund_requested", system, {
      refundId: row.id,
      amountCents: row.amountCents,
      source: "provider",
    });
  }

  // Lock order first, then the refund and payment (same order everywhere → no deadlocks).
  const order = required(await lockOrder(tx, row.orderId), "order");
  const [locked] = await tx.select().from(refunds).where(eq(refunds.id, row.id)).for("update");
  const refund = required(locked, "refund");
  if (FINAL.includes(refund.status) && refund.status === snapshot.status) return refund.status;
  if (refund.status === "succeeded" && snapshot.status !== "failed") return refund.status;

  const [paymentLocked] = refund.paymentId
    ? await tx.select().from(payments).where(eq(payments.id, refund.paymentId)).for("update")
    : [];
  const payment = required(paymentLocked, "payment");
  const final = FINAL.includes(snapshot.status);

  await tx
    .update(refunds)
    .set({
      status: snapshot.status,
      providerRefundId: refund.providerRefundId ?? snapshot.refundId,
      failureReason: snapshot.failureReason,
      submittedAt: refund.submittedAt ?? now,
      settledAt: final ? now : null,
    })
    .where(eq(refunds.id, refund.id));

  if (snapshot.status === "succeeded") {
    const refundedCents = payment.refundedCents + refund.amountCents;
    await tx
      .update(payments)
      .set({
        refundedCents,
        status: paymentStatusAfterRefunds(payment.amountCents, refundedCents),
      })
      .where(eq(payments.id, payment.id));
    await recordOrderEvent(tx, order.id, "refund_recorded", system, {
      refundId: refund.id,
      amountCents: refund.amountCents,
      reason: refund.reason,
    });
    // Only the order's own payment changes the order; late/duplicate money is just returned.
    if (payment.reconciliation === null) await applyRefundToOrder(tx, order, refund, now);
  } else if (snapshot.status === "failed" || snapshot.status === "cancelled") {
    if (refund.status === "succeeded") {
      // The provider reversed a refund it had reported as succeeded (rare, e.g. closed card).
      const refundedCents = Math.max(0, payment.refundedCents - refund.amountCents);
      await tx
        .update(payments)
        .set({
          refundedCents,
          status: paymentStatusAfterRefunds(payment.amountCents, refundedCents),
        })
        .where(eq(payments.id, payment.id));
    }
    await recordOrderEvent(tx, order.id, "refund_failed", system, {
      refundId: refund.id,
      amountCents: refund.amountCents,
      failureReason: snapshot.failureReason,
    });
    await recordAudit(tx, {
      actorUserId: null,
      action: "payment.refund_failed",
      entityType: "order",
      entityId: order.id,
      metadata: { refundId: refund.id, failureReason: snapshot.failureReason },
    });
  }
  return snapshot.status;
}

/** Submits refunds after their transaction committed (best effort; the recovery job retries). */
export async function submitRefunds(
  db: Database,
  refundIds: readonly string[],
  now = new Date(),
): Promise<RefundStatus[]> {
  const results: RefundStatus[] = [];
  for (const id of refundIds) results.push(await submitRefund(db, id, now));
  return results;
}
