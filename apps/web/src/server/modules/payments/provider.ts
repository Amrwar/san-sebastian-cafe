import type { CheckoutSnapshot, PaymentProviderName, RefundStatus } from "@ssc/domain";
import { env } from "../../env";
import { fakeProvider } from "./fake";
import { createStripeProvider } from "./stripe";

/*
 * Provider abstraction. Everything the app needs from a payment processor goes through this
 * interface, so the order/payment logic never depends on Stripe types and another processor
 * (e.g. the café's POS provider, decision D1) can be added as one adapter.
 *
 * Card data never passes through the app: customers pay on the provider's hosted page.
 */

export interface CreateCheckoutInput {
  /** Our attempt id — also the provider idempotency key, so a retried request can't create two. */
  attemptId: string;
  /** What is being paid: an order (default) or a gift card bought online (orderId = purchase id). */
  kind?: "order" | "gift_card";
  orderId: string;
  orderNumber: string;
  amountCents: number;
  /** One-line breakdown shown on the hosted page (subtotal, taxes, tip…). */
  description: string;
  locale: "fr" | "en";
  /** Must contain the literal "{CHECKOUT_SESSION_ID}" placeholder for providers that support it. */
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  customerEmail: string | null;
  providerCustomerId: string | null;
}

export interface CreatedCheckout {
  sessionId: string;
  url: string;
  expiresAt: Date;
}

export interface RefundSnapshot {
  refundId: string;
  /** Provider payment the refund belongs to. */
  paymentId: string | null;
  amountCents: number;
  status: RefundStatus;
  failureReason: string | null;
  /** Our refund id when the refund was created by the app (echoed from metadata). */
  localRefundId: string | null;
}

export interface DisputeSnapshot {
  disputeId: string;
  paymentId: string | null;
  amountCents: number;
  reason: string | null;
  status: string;
  evidenceDueBy: Date | null;
}

/** A webhook whose signature has been verified, reduced to what the app acts on. */
export type VerifiedEvent = { id: string; type: string } & (
  | { kind: "checkout"; sessionId: string }
  | { kind: "payment_failed"; paymentId: string; orderId: string | null; message: string | null }
  | { kind: "refund"; refundId: string }
  | { kind: "dispute"; dispute: DisputeSnapshot }
  | { kind: "ignored" }
);

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Provider customer for a signed-in customer (enables saved cards). Idempotent per user. */
  createCustomer(input: { userId: string; email: string }): Promise<string>;
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  /** Authenticated status check — the provider's own answer, never the browser's. */
  getCheckout(sessionId: string): Promise<CheckoutSnapshot>;
  /** Closes an unpaid hosted page so it can no longer be paid. */
  expireCheckout(sessionId: string): Promise<void>;
  /** Creates (or, with the same key, returns) a refund. */
  refund(input: {
    paymentId: string;
    amountCents: number;
    idempotencyKey: string;
    localRefundId: string;
    reason: "requested_by_customer" | "duplicate" | null;
  }): Promise<RefundSnapshot>;
  getRefund(refundId: string): Promise<RefundSnapshot>;
  /** Verifies the signature (and freshness) of a webhook; throws WebhookSignatureError. */
  verifyWebhook(rawBody: string, signature: string | null): VerifiedEvent;
}

const overrides = new Map<PaymentProviderName, PaymentProvider>();
let stripe: PaymentProvider | undefined;

/**
 * The adapter for a provider. Refunds always use the provider that took the payment, whatever
 * PAYMENT_PROVIDER is set to now.
 */
export function paymentProvider(name: PaymentProviderName): PaymentProvider {
  const override = overrides.get(name);
  if (override) return override;
  if (name === "fake") return fakeProvider;
  if (name === "stripe") {
    const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = env();
    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET)
      throw new Error("Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)");
    stripe ??= createStripeProvider({
      secretKey: STRIPE_SECRET_KEY,
      webhookSecret: STRIPE_WEBHOOK_SECRET,
    });
    return stripe;
  }
  throw new Error(`Payment provider "${name}" is not integrated`);
}

/** The provider new checkouts use (PAYMENT_PROVIDER), or null when payments are off. */
export function checkoutProvider(): PaymentProvider | null {
  const name = env().PAYMENT_PROVIDER;
  return name === "none" ? null : paymentProvider(name);
}

/** Tests only: substitute a scripted provider (e.g. a Stripe double). */
export function overridePaymentProviderForTests(
  name: PaymentProviderName,
  provider: PaymentProvider | null,
): void {
  if (provider) overrides.set(name, provider);
  else overrides.delete(name);
}
