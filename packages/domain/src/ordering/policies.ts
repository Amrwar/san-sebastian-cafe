import type { OrderStatus } from "./ordering";

/**
 * Customer-facing order policies (defaults pending owner decision D16, see docs/07):
 * - Cancel: until the café accepts the order. Paid orders are refunded in full.
 * - Modify: pickup time and instructions only, while not yet accepted and at least
 *   MODIFY_CUTOFF_MINUTES before the scheduled time. Items can't change after ordering —
 *   cancel and re-order instead (prevents price/capacity inconsistencies).
 * - Reject (café): any paid order not yet accepted, with a reason; refunded in full.
 * - Refund (shift lead+): full or partial, never more than what remains refundable.
 */
export const MODIFY_CUTOFF_MINUTES = 15;

const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = ["awaiting_payment", "paid"];

export function customerCanCancel(status: OrderStatus): boolean {
  return CUSTOMER_CANCELLABLE.includes(status);
}

export function customerCanModify(
  order: { status: OrderStatus; scheduledFor: Date | null },
  now: Date,
): boolean {
  if (!CUSTOMER_CANCELLABLE.includes(order.status)) return false;
  // ASAP orders are already being scheduled for preparation; nothing to move.
  if (!order.scheduledFor) return false;
  return order.scheduledFor.getTime() - now.getTime() >= MODIFY_CUTOFF_MINUTES * 60_000;
}

/** A cancellation or rejection of a paid order must be refunded in full. */
export function refundRequiredOnCancel(order: {
  paid: boolean;
  refundedCents: number;
  totalCents: number;
}): number {
  return order.paid ? Math.max(0, order.totalCents - order.refundedCents) : 0;
}

export type RefundCheck =
  { ok: true; fullyRefunded: boolean } | { ok: false; error: "not_paid" | "amount_invalid" };

export function checkRefund(
  order: { paid: boolean; totalCents: number; refundedCents: number },
  amountCents: number,
): RefundCheck {
  if (!order.paid) return { ok: false, error: "not_paid" };
  const remaining = order.totalCents - order.refundedCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > remaining) {
    return { ok: false, error: "amount_invalid" };
  }
  return { ok: true, fullyRefunded: amountCents === remaining };
}
