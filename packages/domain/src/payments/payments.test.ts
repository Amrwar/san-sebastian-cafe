import { describe, expect, it } from "vitest";
import {
  checkoutOutcome,
  classifyIncomingPayment,
  customerPaymentState,
  paymentStatusAfterRefunds,
  refundableCents,
  type CheckoutSnapshot,
} from "./payments";

const snapshot = (over: Partial<CheckoutSnapshot>): CheckoutSnapshot => ({
  sessionId: "cs_1",
  status: "open",
  payment: "unpaid",
  paymentId: null,
  amountCents: 1000,
  currency: "cad",
  orderId: "o1",
  card: null,
  ...over,
});

describe("checkout outcome", () => {
  it("only a paid snapshot counts as paid; a returning browser alone proves nothing", () => {
    expect(checkoutOutcome(snapshot({ status: "complete", payment: "paid" }))).toBe("paid");
    expect(checkoutOutcome(snapshot({ status: "complete", payment: "processing" }))).toBe(
      "processing",
    );
    expect(checkoutOutcome(snapshot({ status: "complete", payment: "failed" }))).toBe("failed");
    expect(checkoutOutcome(snapshot({ status: "expired" }))).toBe("expired");
    expect(checkoutOutcome(snapshot({}))).toBe("open");
  });
});

describe("incoming payment classification", () => {
  const base = {
    orderAwaitingPayment: true,
    orderAlreadyPaid: false,
    amountCents: 1000,
    currency: "cad",
    expectedCents: 1000,
  };

  it("applies the exact amount to an order awaiting payment", () => {
    expect(classifyIncomingPayment(base)).toEqual({ action: "apply" });
  });

  it("refunds a second payment for an already-paid order", () => {
    expect(classifyIncomingPayment({ ...base, orderAlreadyPaid: true })).toEqual({
      action: "refund",
      reconciliation: "duplicate",
    });
  });

  it("refunds money that arrives after the order expired or was cancelled", () => {
    expect(classifyIncomingPayment({ ...base, orderAwaitingPayment: false })).toEqual({
      action: "refund",
      reconciliation: "late",
    });
  });

  it("never applies a different amount or currency", () => {
    for (const over of [{ amountCents: 999 }, { currency: "usd" }, { amountCents: null }]) {
      expect(classifyIncomingPayment({ ...base, ...over })).toEqual({
        action: "refund",
        reconciliation: "amount_mismatch",
      });
    }
  });
});

describe("refund arithmetic", () => {
  it("counts pending refunds so concurrent requests can't refund more than was paid", () => {
    expect(
      refundableCents(1000, [
        { amountCents: 300, status: "succeeded" },
        { amountCents: 200, status: "pending" },
        { amountCents: 500, status: "failed" },
        { amountCents: 100, status: "cancelled" },
      ]),
    ).toBe(500);
    expect(refundableCents(1000, [{ amountCents: 1000, status: "succeeded" }])).toBe(0);
  });

  it("derives the payment status from confirmed refunds", () => {
    expect(paymentStatusAfterRefunds(1000, 0)).toBe("succeeded");
    expect(paymentStatusAfterRefunds(1000, 400)).toBe("partially_refunded");
    expect(paymentStatusAfterRefunds(1000, 1000)).toBe("refunded");
  });
});

describe("customer payment state", () => {
  it("prefers the captured payment, then the latest checkout attempt", () => {
    expect(customerPaymentState({ payment: null, latestAttempt: null })).toBe("unpaid");
    expect(customerPaymentState({ payment: null, latestAttempt: { status: "open" } })).toBe(
      "pending",
    );
    expect(customerPaymentState({ payment: null, latestAttempt: { status: "processing" } })).toBe(
      "processing",
    );
    expect(customerPaymentState({ payment: null, latestAttempt: { status: "failed" } })).toBe(
      "failed",
    );
    expect(customerPaymentState({ payment: null, latestAttempt: { status: "expired" } })).toBe(
      "unpaid",
    );
    expect(
      customerPaymentState({
        payment: { status: "partially_refunded" },
        latestAttempt: { status: "succeeded" },
      }),
    ).toBe("partially_refunded");
  });
});
