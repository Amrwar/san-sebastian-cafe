/**
 * Order lifecycle states. Transition rules (who may move an order from which state to which)
 * are implemented in Phase 3; the persisted vocabulary is defined here so the schema and the
 * state machine can never drift apart.
 */
export const ORDER_STATUSES = [
  "awaiting_payment",
  "paid",
  "accepted",
  "in_preparation",
  "ready",
  "completed",
  "cancelled",
  "expired",
  "refunded",
  "partially_refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILMENT_METHODS = ["pickup", "delivery"] as const;
export type FulfilmentMethod = (typeof FULFILMENT_METHODS)[number];
