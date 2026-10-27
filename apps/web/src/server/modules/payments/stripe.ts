import Stripe from "stripe";
import type { CheckoutSnapshot, RefundStatus } from "@ssc/domain";
import {
  WebhookSignatureError,
  type CreateCheckoutInput,
  type DisputeSnapshot,
  type PaymentProvider,
  type RefundSnapshot,
  type VerifiedEvent,
} from "./provider";

/*
 * Stripe adapter (hosted Checkout). Card details are entered on Stripe's page — the app only ever
 * sees ids, amounts, statuses and the display-only card brand and last 4 digits.
 * The API version is the one pinned by the installed SDK (stripe@22.6.2 → 2026-08-26.dahlia).
 */

export interface StripeProviderConfig {
  secretKey: string;
  webhookSecret: string;
  /** Tests only: point the SDK at a local mock server. */
  host?: string;
  port?: number;
  protocol?: "http" | "https";
}

const id = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === "string" ? value : value.id;

/** Session → provider-agnostic snapshot. Exported for unit tests. */
export function snapshotFromSession(session: Stripe.Checkout.Session): CheckoutSnapshot {
  const intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
  const charge = intent && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card;

  let payment: CheckoutSnapshot["payment"] = "unpaid";
  if (session.payment_status === "paid") payment = "paid";
  else if (session.status === "complete") {
    // Completed but not paid: an asynchronous method is settling, or it failed.
    payment =
      intent?.status === "requires_payment_method" || intent?.status === "canceled"
        ? "failed"
        : "processing";
  }

  return {
    sessionId: session.id,
    status:
      session.status === "complete"
        ? "complete"
        : session.status === "expired"
          ? "expired"
          : "open",
    payment,
    paymentId: id(session.payment_intent),
    amountCents: session.amount_total,
    currency: session.currency,
    orderId: session.metadata?.order_id ?? session.client_reference_id ?? null,
    card: card?.brand && card.last4 ? { brand: card.brand, last4: card.last4 } : null,
  };
}

function refundStatus(status: string | null): RefundStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      return "pending"; // pending, requires_action
  }
}

export function snapshotFromRefund(refund: Stripe.Refund): RefundSnapshot {
  return {
    refundId: refund.id,
    paymentId: id(refund.payment_intent),
    amountCents: refund.amount,
    status: refundStatus(refund.status),
    failureReason: refund.failure_reason ?? null,
    localRefundId: refund.metadata?.refund_id ?? null,
  };
}

export function snapshotFromDispute(dispute: Stripe.Dispute): DisputeSnapshot {
  const due = dispute.evidence_details.due_by;
  return {
    disputeId: dispute.id,
    paymentId: id(dispute.payment_intent),
    amountCents: dispute.amount,
    reason: dispute.reason,
    status: dispute.status,
    evidenceDueBy: due ? new Date(due * 1000) : null,
  };
}

/** Verified Stripe event → the subset the app acts on. Exported for unit tests. */
export function toVerifiedEvent(event: Stripe.Event): VerifiedEvent {
  const base = { id: event.id, type: event.type };
  const object = event.data.object as { object?: string; id?: string };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return { ...base, kind: "checkout", sessionId: (object as Stripe.Checkout.Session).id };
    case "payment_intent.payment_failed": {
      const intent = object as Stripe.PaymentIntent;
      return {
        ...base,
        kind: "payment_failed",
        paymentId: intent.id,
        orderId: intent.metadata.order_id ?? null,
        message: intent.last_payment_error?.message ?? null,
      };
    }
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated":
      return { ...base, kind: "refund", refundId: (object as Stripe.Refund).id };
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      return { ...base, kind: "dispute", dispute: snapshotFromDispute(object as Stripe.Dispute) };
    default:
      return { ...base, kind: "ignored" };
  }
}

export function createStripeProvider(config: StripeProviderConfig): PaymentProvider {
  const stripe = new Stripe(config.secretKey, {
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "san-sebastian-cafe" },
    ...(config.host ? { host: config.host } : {}),
    ...(config.port ? { port: config.port } : {}),
    ...(config.protocol ? { protocol: config.protocol } : {}),
  });

  return {
    name: "stripe",

    async createCustomer({ userId, email }) {
      const customer = await stripe.customers.create(
        { email, metadata: { user_id: userId } },
        { idempotencyKey: `customer-${userId}` },
      );
      return customer.id;
    },

    async createCheckout(input: CreateCheckoutInput) {
      const giftCard = input.kind === "gift_card";
      const metadata: Record<string, string> = giftCard
        ? { gift_card_purchase_id: input.orderId, attempt_id: input.attemptId }
        : { order_id: input.orderId, attempt_id: input.attemptId };
      const name = giftCard
        ? input.locale === "fr"
          ? "Carte-cadeau — San Sebastian Café"
          : "Gift card — San Sebastian Café"
        : input.locale === "fr"
          ? `Commande ${input.orderNumber} — San Sebastian Café`
          : `Order ${input.orderNumber} — San Sebastian Café`;
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          // Cards; Apple Pay and Google Pay appear on Stripe's page as card wallets when enabled.
          payment_method_types: ["card"],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "cad",
                // The server-computed order total (items, discounts, GST/QST, tip, delivery).
                unit_amount: input.amountCents,
                product_data: { name, description: input.description },
              },
            },
          ],
          client_reference_id: input.orderId,
          metadata,
          payment_intent_data: {
            metadata,
            description: `San Sebastian Café ${input.orderNumber}`,
          },
          // Saved cards are offered for orders only.
          ...(input.providerCustomerId && !giftCard
            ? {
                customer: input.providerCustomerId,
                saved_payment_method_options: { payment_method_save: "enabled" },
              }
            : input.customerEmail
              ? { customer_email: input.customerEmail }
              : {}),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
          locale: input.locale === "fr" ? "fr-CA" : "en",
        },
        { idempotencyKey: `checkout-${input.attemptId}` },
      );
      if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
      return {
        sessionId: session.id,
        url: session.url,
        expiresAt: new Date(session.expires_at * 1000),
      };
    },

    async getCheckout(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent", "payment_intent.latest_charge"],
      });
      return snapshotFromSession(session);
    },

    async expireCheckout(sessionId) {
      await stripe.checkout.sessions.expire(sessionId);
    },

    async refund({ paymentId, amountCents, idempotencyKey, localRefundId, reason }) {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentId,
          amount: amountCents,
          metadata: { refund_id: localRefundId },
          ...(reason ? { reason } : {}),
        },
        { idempotencyKey: `refund-${idempotencyKey}` },
      );
      return snapshotFromRefund(refund);
    },

    async getRefund(refundId) {
      return snapshotFromRefund(await stripe.refunds.retrieve(refundId));
    },

    verifyWebhook(rawBody, signature) {
      if (!signature) throw new WebhookSignatureError("Missing Stripe-Signature header");
      let event: Stripe.Event;
      try {
        // Checks the HMAC against the endpoint secret and rejects events older than 5 minutes.
        event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
      } catch {
        throw new WebhookSignatureError();
      }
      return toVerifiedEvent(event);
    },
  };
}
