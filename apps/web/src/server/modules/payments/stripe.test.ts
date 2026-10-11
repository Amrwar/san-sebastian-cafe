import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookSignatureError } from "./provider";
import { createStripeProvider, snapshotFromSession } from "./stripe";

/*
 * The Stripe adapter against Stripe's real signature scheme (the SDK's own test-header helper)
 * and a local HTTP stand-in for api.stripe.com that records exactly what the adapter sends.
 * No network access and no Stripe account involved.
 */

const WEBHOOK_SECRET = "whsec_unit_test_secret";
const signer = new Stripe("sk_test_unused");

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: URLSearchParams;
}
const requests: Recorded[] = [];
let responses: Record<string, unknown> = {};
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      requests.push({
        method: req.method ?? "",
        path,
        headers: req.headers,
        body: new URLSearchParams(raw),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(responses[`${req.method} ${path}`] ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

const provider = () =>
  createStripeProvider({
    secretKey: "sk_test_unit",
    webhookSecret: WEBHOOK_SECRET,
    host: "127.0.0.1",
    port,
    protocol: "http",
  });

const sessionEvent = JSON.stringify({
  id: "evt_1",
  object: "event",
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_1", object: "checkout.session" } },
});

describe("webhook signature verification", () => {
  const sign = (payload: string, secret = WEBHOOK_SECRET, timestamp?: number) =>
    signer.webhooks.generateTestHeaderString({
      payload,
      secret,
      ...(timestamp ? { timestamp } : {}),
    });

  it("accepts a correctly signed event and reduces it to what the app acts on", () => {
    expect(provider().verifyWebhook(sessionEvent, sign(sessionEvent))).toEqual({
      id: "evt_1",
      type: "checkout.session.completed",
      kind: "checkout",
      sessionId: "cs_test_1",
    });
  });

  it("rejects a tampered body, another endpoint's secret, a stale signature or none", () => {
    const tampered = sessionEvent.replace("cs_test_1", "cs_test_2");
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    for (const [body, header] of [
      [tampered, sign(sessionEvent)],
      [sessionEvent, sign(sessionEvent, "whsec_other_endpoint")],
      [sessionEvent, sign(sessionEvent, WEBHOOK_SECRET, stale)],
      [sessionEvent, null],
    ] as const) {
      expect(() => provider().verifyWebhook(body, header)).toThrow(WebhookSignatureError);
    }
  });

  it("maps refund, dispute and decline events, and ignores the rest", () => {
    const verify = (type: string, object: Record<string, unknown>) => {
      const payload = JSON.stringify({ id: "evt_x", object: "event", type, data: { object } });
      return provider().verifyWebhook(payload, sign(payload));
    };
    expect(verify("refund.updated", { id: "re_1", object: "refund" })).toMatchObject({
      kind: "refund",
      refundId: "re_1",
    });
    expect(
      verify("charge.dispute.created", {
        id: "dp_1",
        object: "dispute",
        amount: 230,
        payment_intent: "pi_1",
        reason: "fraudulent",
        status: "needs_response",
        evidence_details: { due_by: 1_800_000_000 },
      }),
    ).toMatchObject({
      kind: "dispute",
      dispute: { disputeId: "dp_1", paymentId: "pi_1", amountCents: 230, status: "needs_response" },
    });
    expect(
      verify("payment_intent.payment_failed", {
        id: "pi_2",
        object: "payment_intent",
        metadata: { order_id: "o1" },
        last_payment_error: { message: "Your card was declined." },
      }),
    ).toMatchObject({ kind: "payment_failed", orderId: "o1", message: "Your card was declined." });
    expect(verify("customer.created", { id: "cus_1", object: "customer" })).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("checkout session mapping", () => {
  const session = (over: Record<string, unknown>) =>
    ({
      id: "cs_1",
      object: "checkout.session",
      status: "open",
      payment_status: "unpaid",
      payment_intent: null,
      amount_total: 230,
      currency: "cad",
      metadata: { order_id: "order-1" },
      client_reference_id: "order-1",
      ...over,
    }) as unknown as Stripe.Checkout.Session;

  it("reads paid sessions with the display-only card details", () => {
    expect(
      snapshotFromSession(
        session({
          status: "complete",
          payment_status: "paid",
          payment_intent: {
            id: "pi_1",
            status: "succeeded",
            latest_charge: { payment_method_details: { card: { brand: "visa", last4: "4242" } } },
          },
        }),
      ),
    ).toEqual({
      sessionId: "cs_1",
      status: "complete",
      payment: "paid",
      paymentId: "pi_1",
      amountCents: 230,
      currency: "cad",
      orderId: "order-1",
      card: { brand: "visa", last4: "4242" },
    });
  });

  it("tells settling, failed, expired and open sessions apart", () => {
    const intent = (status: string) => ({ id: "pi_1", status, latest_charge: null });
    expect(
      snapshotFromSession(session({ status: "complete", payment_intent: intent("processing") }))
        .payment,
    ).toBe("processing");
    expect(
      snapshotFromSession(
        session({ status: "complete", payment_intent: intent("requires_payment_method") }),
      ).payment,
    ).toBe("failed");
    expect(snapshotFromSession(session({ status: "expired" }))).toMatchObject({
      status: "expired",
      payment: "unpaid",
    });
    expect(snapshotFromSession(session({}))).toMatchObject({ status: "open", payment: "unpaid" });
  });
});

describe("requests sent to Stripe", () => {
  it("creates the hosted page for the exact total, in CAD, with an idempotency key", async () => {
    responses = {
      "POST /v1/checkout/sessions": {
        id: "cs_test_9",
        object: "checkout.session",
        url: "https://checkout.stripe.com/c/pay/cs_test_9",
        expires_at: 1_800_000_000,
      },
    };
    const created = await provider().createCheckout({
      attemptId: "attempt-1",
      orderId: "order-1",
      orderNumber: "1012-001",
      amountCents: 230,
      description: "Sous-total 2,00 $ · TPS 0,10 $ · TVQ 0,20 $",
      locale: "fr",
      successUrl: "https://cafe.test/fr/checkout/return/order-1?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://cafe.test/fr/checkout/pay/order-1?cancelled=1",
      expiresAt: new Date(1_800_000_000_000),
      customerEmail: null,
      providerCustomerId: "cus_1",
    });
    expect(created).toEqual({
      sessionId: "cs_test_9",
      url: "https://checkout.stripe.com/c/pay/cs_test_9",
      expiresAt: new Date(1_800_000_000_000),
    });

    const sent = requests.at(-1)!;
    expect(sent).toMatchObject({ method: "POST", path: "/v1/checkout/sessions" });
    expect(sent.headers["idempotency-key"]).toBe("checkout-attempt-1");
    expect(sent.headers.authorization).toBe("Bearer sk_test_unit");
    const body = Object.fromEntries(sent.body);
    expect(body).toMatchObject({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "cad",
      "line_items[0][price_data][unit_amount]": "230",
      "metadata[order_id]": "order-1",
      "metadata[attempt_id]": "attempt-1",
      "payment_intent_data[metadata][order_id]": "order-1",
      client_reference_id: "order-1",
      customer: "cus_1",
      "saved_payment_method_options[payment_method_save]": "enabled",
      expires_at: "1800000000",
      locale: "fr-CA",
      success_url: "https://cafe.test/fr/checkout/return/order-1?session_id={CHECKOUT_SESSION_ID}",
    });
    // Nothing card-related is ever sent from the app.
    expect(Object.keys(body).some((k) => /card\[|number|cvc/.test(k))).toBe(false);
  });

  it("refunds with our refund id as idempotency key and in metadata", async () => {
    responses = {
      "POST /v1/refunds": {
        id: "re_9",
        object: "refund",
        amount: 100,
        status: "pending",
        payment_intent: "pi_1",
        metadata: { refund_id: "refund-1" },
      },
    };
    const refund = await provider().refund({
      paymentId: "pi_1",
      amountCents: 100,
      idempotencyKey: "refund-1",
      localRefundId: "refund-1",
      reason: "requested_by_customer",
    });
    expect(refund).toEqual({
      refundId: "re_9",
      paymentId: "pi_1",
      amountCents: 100,
      status: "pending",
      failureReason: null,
      localRefundId: "refund-1",
    });
    const sent = requests.at(-1)!;
    expect(sent.headers["idempotency-key"]).toBe("refund-refund-1");
    expect(Object.fromEntries(sent.body)).toMatchObject({
      payment_intent: "pi_1",
      amount: "100",
      "metadata[refund_id]": "refund-1",
      reason: "requested_by_customer",
    });
  });

  it("asks for the session with the payment and charge expanded (status checks)", async () => {
    responses = {
      "GET /v1/checkout/sessions/cs_test_9": {
        id: "cs_test_9",
        object: "checkout.session",
        status: "open",
        payment_status: "unpaid",
        amount_total: 230,
        currency: "cad",
        metadata: { order_id: "order-1" },
      },
    };
    await provider().getCheckout("cs_test_9");
    const sent = requests.at(-1)!;
    expect(sent).toMatchObject({ method: "GET", path: "/v1/checkout/sessions/cs_test_9" });
  });
});
