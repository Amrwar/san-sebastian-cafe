/**
 * Order lifecycle states (persisted vocabulary). Transition rules live in ./state-machine.ts.
 * New values are only ever appended (Postgres enum values can be added, not reordered).
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
  "rejected",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILMENT_METHODS = ["pickup", "delivery"] as const;
export type FulfilmentMethod = (typeof FULFILMENT_METHODS)[number];
