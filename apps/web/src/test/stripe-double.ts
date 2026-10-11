import type { CheckoutSnapshot, RefundStatus } from "@ssc/domain";
import {
  WebhookSignatureError,
  type CreateCheckoutInput,
  type PaymentProvider,
  type RefundSnapshot,
  type VerifiedEvent,
} from "@/server/modules/payments/provider";

/**
 * TEST DOUBLE of the Stripe adapter for integration tests: keeps sessions and refunds in memory
 * and lets a test decide what "Stripe" says (paid, processing, failed, refund pending…). It is
 * not a Stripe sandbox: the real adapter is tested against Stripe's request/response shapes and
 * signature scheme in stripe.test.ts, and end-to-end in the sandbox (docs/13-payments.md).
 * Webhooks are "signed" with the literal signature "valid".
 */
export class StripeDouble implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly sessions = new Map<string, CheckoutSnapshot>();
  readonly checkoutsCreated: CreateCheckoutInput[] = [];
  readonly expired: string[] = [];
  readonly refundCalls: Array<{ idempotencyKey: string; amountCents: number }> = [];
  private readonly refunds = new Map<string, RefundSnapshot>();
  private readonly refundsByKey = new Map<string, string>();
  private counter = 0;
  /** Status Stripe reports for new refunds. */
  refundStatus: RefundStatus = "succeeded";
  /** Make the next N refund calls fail like a network timeout (after Stripe may have acted). */
  refundFailures = 0;

  private next(prefix: string) {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  createCustomer() {
    return Promise.resolve(this.next("cus"));
  }

  createCheckout(input: CreateCheckoutInput) {
    this.checkoutsCreated.push(input);
    const sessionId = this.next("cs_test");
    this.sessions.set(sessionId, {
      sessionId,
      status: "open",
      payment: "unpaid",
      paymentId: null,
      amountCents: input.amountCents,
      currency: "cad",
      orderId: input.orderId,
      card: null,
    });
    return Promise.resolve({
      sessionId,
      url: `https://checkout.stripe.test/${sessionId}`,
      expiresAt: input.expiresAt,
    });
  }

  getCheckout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`No such session ${sessionId}`));
    return Promise.resolve({ ...session });
  }

  expireCheckout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open")
      return Promise.reject(new Error("Only open sessions can be expired"));
    session.status = "expired";
    this.expired.push(sessionId);
    return Promise.resolve();
  }

  /** The customer completes the hosted page. */
  pay(
    sessionId: string,
    outcome: "paid" | "processing" | "failed" = "paid",
    overrides: Partial<CheckoutSnapshot> = {},
  ): CheckoutSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No such session ${sessionId}`);
    Object.assign(session, {
      status: "complete",
      payment: outcome,
      paymentId: session.paymentId ?? this.next("pi"),
      card: { brand: "visa", last4: "4242" },
      ...overrides,
    });
    return { ...session };
  }

  refund(input: {
    paymentId: string;
    amountCents: number;
    idempotencyKey: string;
    localRefundId: string;
  }) {
    this.refundCalls.push({ idempotencyKey: input.idempotencyKey, amountCents: input.amountCents });
    // Like Stripe: the same idempotency key returns the refund created the first time.
    const existing = this.refundsByKey.get(input.idempotencyKey);
    let refund = existing ? this.refunds.get(existing) : undefined;
    if (!refund) {
      refund = {
        refundId: this.next("re"),
        paymentId: input.paymentId,
        amountCents: input.amountCents,
        status: this.refundStatus,
        failureReason: this.refundStatus === "failed" ? "expired_or_canceled_card" : null,
        localRefundId: input.localRefundId,
      };
      this.refunds.set(refund.refundId, refund);
      this.refundsByKey.set(input.idempotencyKey, refund.refundId);
    }
    if (this.refundFailures > 0) {
      this.refundFailures -= 1;
      return Promise.reject(new Error("ETIMEDOUT (simulated)"));
    }
    return Promise.resolve({ ...refund });
  }

  /** Stripe changes a refund's status later (then sends refund.updated). */
  setRefund(refundId: string, change: Partial<RefundSnapshot>) {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`No such refund ${refundId}`);
    Object.assign(refund, change);
  }

  /** A refund created outside the app (Stripe dashboard). */
  dashboardRefund(paymentId: string, amountCents: number): RefundSnapshot {
    const refund: RefundSnapshot = {
      refundId: this.next("re"),
      paymentId,
      amountCents,
      status: "succeeded",
      failureReason: null,
      localRefundId: null,
    };
    this.refunds.set(refund.refundId, refund);
    return refund;
  }

  get refundsCreated() {
    return this.refunds.size;
  }

  getRefund(refundId: string) {
    const refund = this.refunds.get(refundId);
    if (!refund) return Promise.reject(new Error(`No such refund ${refundId}`));
    return Promise.resolve({ ...refund });
  }

  verifyWebhook(rawBody: string, signature: string | null): VerifiedEvent {
    if (signature !== "valid") throw new WebhookSignatureError();
    const event = JSON.parse(rawBody) as VerifiedEvent;
    if (event.kind === "dispute" && event.dispute.evidenceDueBy)
      event.dispute.evidenceDueBy = new Date(event.dispute.evidenceDueBy);
    return event;
  }
}
