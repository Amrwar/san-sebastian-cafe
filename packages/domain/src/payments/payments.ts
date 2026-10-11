export const PAYMENT_PROVIDERS = ["fake", "stripe", "square"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ["pending", "succeeded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
