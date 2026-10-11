import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  lt,
  orderEvents,
  orderStatusEvents,
  orders,
  payments,
  refunds,
  sql,
  type Tx,
} from "@ssc/db";
import {
  checkRefund,
  checkTransition,
  type OrderStatus,
  type Role,
  type TransitionActor,
} from "@ssc/domain";
import { AppError, required } from "../../errors";
import { earnForOrder, reverseForOrder, settleRedemption } from "../loyalty/ledger";
import { paymentProvider } from "../payments/provider";

/** Who is acting on an order, as the services see it. */
export type OrderActor =
  | { kind: "system" }
  | { kind: "customer"; userId: string | null }
  | { kind: "staff"; userId: string; role: Role };

export type OrderRow = typeof orders.$inferSelect;
type EventType = (typeof orderEvents.$inferInsert)["type"];

function actorKind(actor: OrderActor): "system" | "customer" | "staff" {
  return actor.kind;
}

function actorUserId(actor: OrderActor): string | null {
  return actor.kind === "system" ? null : actor.userId;
}

/** Locks an order row for the rest of the transaction. */
export async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow | undefined> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  return order;
}

export async function recordOrderEvent(
  tx: Tx,
  orderId: string,
  type: EventType,
  actor: OrderActor,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(orderEvents).values({
    orderId,
    type,
    actorKind: actorKind(actor),
    actorUserId: actorUserId(actor),
    data,
  });
}

function toTransitionActor(
  actor: OrderActor,
  order: OrderRow,
  guestVerified: boolean,
): TransitionActor {
  if (actor.kind === "system") return { kind: "system" };
  if (actor.kind === "staff") return { kind: "staff", role: actor.role };
  const ownsOrder = actor.userId ? order.userId === actor.userId : guestVerified;
  return { kind: "customer", ownsOrder };
}

const STATUS_TIMESTAMPS: Partial<
  Record<OrderStatus, "paidAt" | "acceptedAt" | "readyAt" | "completedAt">
> = {
  paid: "paidAt",
  accepted: "acceptedAt",
  ready: "readyAt",
  completed: "completedAt",
};

/**
 * Applies one validated status transition to a LOCKED order row and returns the updated row.
 * Writes the status timeline, the full event history and loyalty side effects atomically.
 * `expectedVersion` (from the staff screen) turns a concurrent change into a 409 conflict.
 */
export async function applyTransition(
  tx: Tx,
  order: OrderRow,
  to: OrderStatus,
  actor: OrderActor,
  options: {
    reason?: string | null;
    expectedVersion?: number;
    guestVerified?: boolean;
    now?: Date;
  } = {},
): Promise<OrderRow> {
  if (options.expectedVersion !== undefined && options.expectedVersion !== order.version) {
    throw new AppError("conflict", "Order changed since it was displayed");
  }
  const check = checkTransition(
    { status: order.status, paid: order.paidAt !== null },
    to,
    toTransitionActor(actor, order, options.guestVerified ?? false),
    options.reason,
  );
  if (!check.ok) {
    if (check.error === "not_permitted")
      throw new AppError("forbidden", `Not permitted: ${order.status} → ${to}`);
    if (check.error === "reason_required") {
      throw new AppError("validation_failed", "A reason is required", [
        { path: "reason", code: "required" },
      ]);
    }
    throw new AppError("conflict", `Invalid transition ${order.status} → ${to} (${check.error})`);
  }

  const now = options.now ?? new Date();
  const stamp = STATUS_TIMESTAMPS[to];
  const [updated] = await tx
    .update(orders)
    .set({
      status: to,
      version: sql`${orders.version} + 1`,
      ...(stamp ? { [stamp]: now } : {}),
      // The reason shown to the customer is the café's; a customer's own cancellation needs none
      // (it stays in the event history).
      ...(to === "cancelled" || to === "rejected"
        ? { cancellationReason: actor.kind === "customer" ? null : (options.reason ?? null) }
        : {}),
    })
    .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
    .returning();
  if (!updated) throw new AppError("conflict", "Order changed concurrently");

  await tx.insert(orderStatusEvents).values({
    orderId: order.id,
    fromStatus: order.status,
    toStatus: to,
    actorKind: actor.kind === "customer" ? "customer" : actor.kind === "staff" ? "staff" : "system",
    actorUserId: actorUserId(actor),
    reason: options.reason ?? null,
    createdAt: now,
  });
  await recordOrderEvent(tx, order.id, "status_changed", actor, {
    from: order.status,
    to,
    ...(options.reason ? { reason: options.reason } : {}),
  });

  // Loyalty side effects.
  if (to === "paid") {
    await settleRedemption(tx, order.id, "commit");
    if (order.userId) {
      const rewarded =
        (order.pricingSnapshot as { rewardedOrderItemId?: string | null }).rewardedOrderItemId ??
        null;
      await earnForOrder(tx, order.id, order.userId, rewarded);
    }
  } else if (
    to === "expired" ||
    ((to === "cancelled" || to === "rejected") && order.paidAt === null)
  ) {
    await settleRedemption(tx, order.id, "release");
  } else if (to === "refunded") {
    await settleRedemption(tx, order.id, "release");
    if (order.userId) await reverseForOrder(tx, order.id, order.userId);
  }
  return updated;
}

/**
 * Refunds `amountCents` of a paid order through the payment provider and moves the order to
 * refunded / partially_refunded. Called after cancel/reject (full amount) or by a shift lead.
 * `requestedBy` is recorded on the refund; `transitionAs` performs the status change (the system,
 * for automatic refunds that follow a cancellation or rejection).
 */
export async function refundInTransaction(
  tx: Tx,
  order: OrderRow,
  amountCents: number,
  reason: string,
  actor: OrderActor,
  transitionAs: OrderActor = actor,
  now = new Date(),
): Promise<OrderRow> {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, "succeeded")))
    .orderBy(desc(payments.createdAt))
    .limit(1)
    .for("update");
  const refundedCents = payment?.refundedCents ?? 0;
  const check = checkRefund(
    { paid: Boolean(payment), totalCents: order.totalCents, refundedCents },
    amountCents,
  );
  if (!check.ok || !payment) {
    throw new AppError("validation_failed", "Refund not allowed", [
      { path: "amountCents", code: check.ok ? "no_payment" : check.error },
    ]);
  }

  const result = await paymentProvider(payment.provider).refund({
    paymentId: payment.providerPaymentId,
    amountCents,
    idempotencyKey: randomUUID(),
  });
  await tx.insert(refunds).values({
    orderId: order.id,
    paymentId: payment.id,
    amountCents,
    reason,
    status: result.status,
    providerRefundId: result.providerRefundId,
    requestedByUserId: actorUserId(actor),
  });
  if (result.status !== "succeeded") {
    // Asynchronous providers confirm later via webhook (Phase 6); the status changes then.
    await recordOrderEvent(tx, order.id, "refund_recorded", actor, {
      amountCents,
      status: result.status,
    });
    return order;
  }
  await tx
    .update(payments)
    .set({ refundedCents: refundedCents + amountCents })
    .where(eq(payments.id, payment.id));
  await recordOrderEvent(tx, order.id, "refund_recorded", actor, { amountCents, reason });
  const fresh = required(await lockOrder(tx, order.id), "order");
  return applyTransition(
    tx,
    fresh,
    check.fullyRefunded ? "refunded" : "partially_refunded",
    transitionAs,
    { reason, now },
  );
}

/** Moves unpaid orders past their expiry to "expired", freeing their slot and reward. */
export async function expireStaleOrders(tx: Tx, now: Date): Promise<number> {
  const stale = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "awaiting_payment"), lt(orders.expiresAt, now)))
    .for("update", { skipLocked: true });
  for (const { id } of stale) {
    const order = required(await lockOrder(tx, id), "order");
    if (order.status === "awaiting_payment")
      await applyTransition(tx, order, "expired", { kind: "system" }, { now });
  }
  return stale.length;
}
