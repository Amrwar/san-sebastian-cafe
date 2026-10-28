import { and, eq, lt, orderEvents, orderStatusEvents, orders, sql, type Tx } from "@ssc/db";
import {
  checkTransition,
  stockReturnsOn,
  type OrderStatus,
  type Role,
  type TransitionActor,
} from "@ssc/domain";
import { AppError, required } from "../../errors";
import { queueOrderNotifications } from "../../notifications/outbox";
import { releaseOrderGiftCard } from "../gift-cards/ledger";
import { releaseStock } from "../inventory/stock";
import {
  commitRedemptions,
  earnForOrder,
  reinstateRedemptions,
  reverseOrder,
} from "../loyalty/earning";
import { releaseReservations } from "../loyalty/ledger";
import { currentRules } from "../loyalty/program";
import { rewardReferral } from "../loyalty/referrals";

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

export function actorUserId(actor: OrderActor): string | null {
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
  Record<OrderStatus, "paidAt" | "acceptedAt" | "readyAt" | "outForDeliveryAt" | "completedAt">
> = {
  paid: "paidAt",
  accepted: "acceptedAt",
  ready: "readyAt",
  out_for_delivery: "outForDeliveryAt",
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
    { status: order.status, paid: order.paidAt !== null, fulfilment: order.fulfilment },
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

  // Loyalty side effects (same transaction; see modules/loyalty/earning.ts).
  if (to === "paid") {
    await commitRedemptions(tx, updated, now);
    if ((await currentRules(tx)).earnOn === "paid") await earnForOrder(tx, updated, now);
  } else if (to === "completed") {
    if ((await currentRules(tx)).earnOn === "completed") await earnForOrder(tx, updated, now);
    // A newcomer's first completed order may reward a referral (loyalty/referrals.ts).
    await rewardReferral(tx, updated, now);
  } else if (to === "expired" || ((to === "cancelled" || to === "rejected") && !order.paidAt)) {
    await releaseReservations(tx, order.id, now);
  } else if (to === "cancelled" || to === "rejected") {
    // A paid order that is stopped: the drinks were never handed over, so the stamps are taken
    // back and the free drink is given back now, whether or not the refund has settled yet.
    await reverseOrder(tx, updated, to, now);
    await reinstateRedemptions(tx, updated, to, now);
  } else if (to === "refunded") {
    await reverseOrder(tx, updated, "refund", now);
    await reinstateRedemptions(tx, updated, "refund", now);
  }
  // Stock goes back on the shelf if the order is stopped before anything was made.
  if (stockReturnsOn(order.status, to)) await releaseStock(tx, order.id, actorUserId(actor));
  // An unpaid order that won't be paid gives its gift card hold back (a paid one is refunded).
  if (to === "expired" || ((to === "cancelled" || to === "rejected") && !order.paidAt))
    await releaseOrderGiftCard(tx, order.id, actorUserId(actor));
  // Customer emails and push notices (outbox, same transaction).
  await queueOrderNotifications(tx, order, updated, now);
  return updated;
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
