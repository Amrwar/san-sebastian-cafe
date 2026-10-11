export const PAYMENT_PROVIDERS = ["fake", "stripe", "square"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

/**
 * A captured payment (one per successful provider charge). Values are append-only because they
 * back a Postgres enum. "Authorized but not captured" isn't used: Stripe Checkout captures
 * automatically, so a payment is recorded only once the money is taken.
 */
export const PAYMENT_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "cancelled",
  "partially_refunded",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ["pending", "succeeded", "failed", "cancelled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * One customer attempt to pay an order through the provider's hosted checkout. At most one
 * attempt per order is live (open or processing) at a time — enforced by a partial unique index.
 */
export const PAYMENT_ATTEMPT_STATUSES = [
  "open",
  "processing",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];
export const LIVE_ATTEMPT_STATUSES: readonly PaymentAttemptStatus[] = ["open", "processing"];

/** Why a payment was recorded but must be given back instead of paying for the order. */
export const PAYMENT_RECONCILIATIONS = ["late", "duplicate", "amount_mismatch"] as const;
export type PaymentReconciliation = (typeof PAYMENT_RECONCILIATIONS)[number];

/** Provider-agnostic view of a hosted checkout, read from a verified webhook or a status check. */
export interface CheckoutSnapshot {
  sessionId: string;
  /** Checkout page state. */
  status: "open" | "complete" | "expired";
  /** Money state: "processing" = asynchronous method still settling; "failed" = it didn't. */
  payment: "unpaid" | "processing" | "paid" | "failed";
  /** Provider payment reference (e.g. Stripe PaymentIntent id), once there is one. */
  paymentId: string | null;
  amountCents: number | null;
  currency: string | null;
  /** Order id echoed back from the session metadata. */
  orderId: string | null;
  card: { brand: string; last4: string } | null;
}

export type CheckoutOutcome = "paid" | "processing" | "failed" | "expired" | "open";

export function checkoutOutcome(s: CheckoutSnapshot): CheckoutOutcome {
  if (s.payment === "paid") return "paid";
  if (s.payment === "processing") return "processing";
  if (s.payment === "failed") return "failed";
  if (s.status === "expired") return "expired";
  return "open";
}

/**
 * What to do with money that arrived for an order. Only an order still awaiting payment, with no
 * other payment, for the exact amount and currency, is paid by it; anything else is refunded.
 */
export function classifyIncomingPayment(input: {
  orderAwaitingPayment: boolean;
  orderAlreadyPaid: boolean;
  amountCents: number | null;
  currency: string | null;
  expectedCents: number;
}): { action: "apply" } | { action: "refund"; reconciliation: PaymentReconciliation } {
  if (input.amountCents !== input.expectedCents || input.currency?.toUpperCase() !== "CAD")
    return { action: "refund", reconciliation: "amount_mismatch" };
  if (input.orderAlreadyPaid) return { action: "refund", reconciliation: "duplicate" };
  if (!input.orderAwaitingPayment) return { action: "refund", reconciliation: "late" };
  return { action: "apply" };
}

/** Amount still refundable: pending refunds count, so two concurrent refunds can't overdraw. */
export function refundableCents(
  paymentCents: number,
  refunds: ReadonlyArray<{ amountCents: number; status: RefundStatus }>,
): number {
  const committed = refunds
    .filter((r) => r.status === "pending" || r.status === "succeeded")
    .reduce((sum, r) => sum + r.amountCents, 0);
  return Math.max(0, paymentCents - committed);
}

/** Payment status after its confirmed refunds. */
export function paymentStatusAfterRefunds(
  paymentCents: number,
  refundedCents: number,
): Extract<PaymentStatus, "succeeded" | "partially_refunded" | "refunded"> {
  if (refundedCents <= 0) return "succeeded";
  return refundedCents >= paymentCents ? "refunded" : "partially_refunded";
}

/** What the customer sees about paying for an order. */
export type CustomerPaymentState =
  "unpaid" | "pending" | "processing" | "paid" | "failed" | "partially_refunded" | "refunded";

export function customerPaymentState(input: {
  payment: { status: PaymentStatus } | null;
  latestAttempt: { status: PaymentAttemptStatus } | null;
}): CustomerPaymentState {
  const { payment, latestAttempt } = input;
  if (payment) {
    if (payment.status === "refunded") return "refunded";
    if (payment.status === "partially_refunded") return "partially_refunded";
    if (payment.status === "succeeded") return "paid";
  }
  switch (latestAttempt?.status) {
    case "processing":
      return "processing";
    case "open":
      return "pending";
    case "failed":
      return "failed";
    default:
      return "unpaid";
  }
}

/**
 * Smallest card charge the provider accepts (Stripe: C$0.50). Orders between 1 ¢ and this are
 * refused at checkout; an order discounted to exactly 0 needs no payment at all.
 */
export const MIN_CARD_CHARGE_CENTS = 50;
