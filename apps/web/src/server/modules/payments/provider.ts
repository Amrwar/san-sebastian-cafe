import { randomUUID } from "node:crypto";
import type { PaymentProviderName } from "@ssc/domain";

/**
 * Payment provider boundary. Phase 6 adds the real Canadian provider (decision D1/D2) behind this
 * interface; the order domain never talks to a provider SDK directly.
 */
export interface RefundRequest {
  paymentId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Starts a refund. Synchronous providers return "succeeded"; others confirm via webhook. */
  refund(
    request: RefundRequest,
  ): Promise<{ providerRefundId: string; status: "succeeded" | "pending" | "failed" }>;
}

/**
 * Development-only simulator: no money moves, refunds "succeed" immediately. Environment
 * validation refuses PAYMENT_PROVIDER=fake in staging and production.
 */
const fakeProvider: PaymentProvider = {
  name: "fake",
  refund: () =>
    Promise.resolve({ providerRefundId: `fake_re_${randomUUID()}`, status: "succeeded" }),
};

export function paymentProvider(name: PaymentProviderName): PaymentProvider {
  if (name === "fake") return fakeProvider;
  throw new Error(`Payment provider "${name}" is not integrated yet (Phase 6)`);
}
