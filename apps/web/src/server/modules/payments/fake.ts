import { randomUUID } from "node:crypto";
import type { PaymentProvider } from "./provider";

/**
 * DEVELOPMENT-ONLY simulator: no money moves and nothing leaves the server. Its "hosted page" is
 * the app's own payment step, whose approve/decline buttons call /api/dev/fake-payments, which
 * feeds the same reconciliation code as Stripe. Environment validation refuses
 * PAYMENT_PROVIDER=fake in staging and production.
 */
export const fakeProvider: PaymentProvider = {
  name: "fake",

  createCustomer: ({ userId }) => Promise.resolve(`fake_cus_${userId}`),

  createCheckout: (input) =>
    Promise.resolve({
      sessionId: `fake_cs_${input.attemptId}`,
      // The simulator lives on the payment step itself (success URL minus the session id).
      url: input.cancelUrl,
      expiresAt: input.expiresAt,
    }),

  // There is no remote state to ask: the simulator reports outcomes directly.
  getCheckout: (sessionId) =>
    Promise.resolve({
      sessionId,
      status: "open",
      payment: "unpaid",
      paymentId: null,
      amountCents: null,
      currency: null,
      orderId: null,
      card: null,
    }),

  expireCheckout: () => Promise.resolve(),

  refund: ({ paymentId, amountCents, localRefundId }) =>
    Promise.resolve({
      refundId: `fake_re_${randomUUID()}`,
      paymentId,
      amountCents,
      status: "succeeded",
      failureReason: null,
      localRefundId,
    }),

  getRefund: (refundId) =>
    Promise.resolve({
      refundId,
      paymentId: null,
      amountCents: 0,
      status: "succeeded",
      failureReason: null,
      localRefundId: null,
    }),

  verifyWebhook: () => {
    throw new Error("The development simulator has no webhooks");
  },
};
