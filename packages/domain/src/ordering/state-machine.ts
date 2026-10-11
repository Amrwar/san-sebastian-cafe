import { can, type Permission, type Role } from "../identity/roles";
import type { OrderStatus } from "./ordering";

/**
 * Order lifecycle (owner-configurable policies are in ./policies.ts):
 *
 *   awaiting_payment ─┬─► paid ─┬─► accepted ─► in_preparation ─► ready ─► completed
 *                     │         ├─► rejected (café can't fulfil; refund follows)
 *                     ├─► expired (unpaid too long)
 *                     └─► cancelled ◄── paid / accepted / in_preparation / ready (with reason)
 *   completed / cancelled / rejected (paid) ──► partially_refunded ──► refunded
 *
 * Every change goes through `checkTransition`; nothing writes `orders.status` directly.
 */

export type TransitionActor =
  { kind: "system" } | { kind: "customer"; ownsOrder: boolean } | { kind: "staff"; role: Role };

type Who = "system" | "owner" | Permission;

interface Rule {
  from: readonly OrderStatus[];
  to: OrderStatus;
  who: readonly Who[];
  /** A written reason is mandatory (stored in the event history and shown to staff). */
  reasonRequired?: boolean;
}

/**
 * Refunds apply to orders that are finished (completed) or stopped (cancelled/rejected). An order
 * still in the kitchen is cancelled instead — cancellation refunds it in full automatically — so
 * a refund can never strand an order mid-preparation.
 */
const REFUNDABLE_STATES: readonly OrderStatus[] = ["completed", "cancelled", "rejected"];

export const TRANSITION_RULES: readonly Rule[] = [
  { from: ["awaiting_payment"], to: "paid", who: ["system"] },
  { from: ["awaiting_payment"], to: "expired", who: ["system"] },
  { from: ["awaiting_payment"], to: "cancelled", who: ["system", "owner", "orders:cancel"] },
  { from: ["paid"], to: "accepted", who: ["system", "orders:transition"] },
  { from: ["paid"], to: "rejected", who: ["orders:transition"], reasonRequired: true },
  // Customers may cancel until the café accepts the order (see policies.customerCanCancel).
  { from: ["paid"], to: "cancelled", who: ["owner", "orders:cancel"] },
  {
    from: ["accepted", "in_preparation", "ready"],
    to: "cancelled",
    who: ["orders:cancel"],
    reasonRequired: true,
  },
  { from: ["accepted"], to: "in_preparation", who: ["orders:transition"] },
  { from: ["in_preparation"], to: "ready", who: ["orders:transition"] },
  { from: ["ready"], to: "completed", who: ["orders:transition"] },
  {
    from: [...REFUNDABLE_STATES, "partially_refunded"],
    to: "partially_refunded",
    who: ["system", "orders:refund"],
    reasonRequired: true,
  },
  {
    from: [...REFUNDABLE_STATES, "partially_refunded"],
    to: "refunded",
    who: ["system", "orders:refund"],
    reasonRequired: true,
  },
];

export type TransitionError =
  "invalid_transition" | "not_permitted" | "reason_required" | "not_paid";

export interface TransitionContext {
  status: OrderStatus;
  /** Refund transitions require that the order was actually paid. */
  paid: boolean;
}

function actorMatches(actor: TransitionActor, who: readonly Who[]): boolean {
  return who.some((w) => {
    if (w === "system") return actor.kind === "system";
    if (w === "owner") return actor.kind === "customer" && actor.ownsOrder;
    return actor.kind === "staff" && can(actor.role, w);
  });
}

export function checkTransition(
  order: TransitionContext,
  to: OrderStatus,
  actor: TransitionActor,
  reason?: string | null,
): { ok: true } | { ok: false; error: TransitionError } {
  const rules = TRANSITION_RULES.filter((r) => r.to === to && r.from.includes(order.status));
  if (rules.length === 0) return { ok: false, error: "invalid_transition" };
  const rule = rules.find((r) => actorMatches(actor, r.who));
  if (!rule) return { ok: false, error: "not_permitted" };
  if ((to === "refunded" || to === "partially_refunded") && !order.paid)
    return { ok: false, error: "not_paid" };
  if (rule.reasonRequired && !(reason && reason.trim().length >= 3))
    return { ok: false, error: "reason_required" };
  return { ok: true };
}

/** Next statuses this actor may move the order to (drives the staff action buttons). */
export function allowedTransitions(
  order: TransitionContext,
  actor: TransitionActor,
): OrderStatus[] {
  const targets = new Set(
    TRANSITION_RULES.filter((r) => r.from.includes(order.status)).map((r) => r.to),
  );
  return [...targets].filter((to) => {
    const result = checkTransition(order, to, actor, "placeholder reason");
    return result.ok;
  });
}

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  "completed",
  "cancelled",
  "expired",
  "rejected",
  "refunded",
];

/** Statuses in which the café is (or will be) preparing the order. */
export const KITCHEN_STATUSES: readonly OrderStatus[] = [
  "paid",
  "accepted",
  "in_preparation",
  "ready",
];
