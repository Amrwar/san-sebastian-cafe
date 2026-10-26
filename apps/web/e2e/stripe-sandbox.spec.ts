import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createDb, eq, orders, paymentDisputes, payments, refunds } from "@ssc/db";
import Stripe from "stripe";
import { choosePickupTime } from "./helpers";

/*
 * STRIPE SANDBOX END-TO-END — real Stripe test mode, real hosted Checkout, Stripe test cards.
 * Runs only when explicitly requested with test-mode keys configured:
 *
 *   STRIPE_E2E=1 npx playwright test stripe-sandbox --project=desktop
 *
 * (PAYMENT_PROVIDER=stripe and the sk_test_/whsec_ keys come from the root .env; see
 * docs/13-payments.md. Without `stripe listen` forwarding webhooks to :3100 the return page still
 * confirms the payment through an authenticated status check.) Skipped otherwise — never treated
 * as passed when it didn't run.
 *
 * Webhook scenarios don't need `stripe listen`: they fetch the real events from Stripe's API and
 * deliver them to the endpoint signed with STRIPE_WEBHOOK_SECRET, as the CLI would. The app then
 * reads the current state back from Stripe, as it does for any webhook.
 */
const enabled =
  process.env.STRIPE_E2E === "1" && /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");

test.describe("Stripe sandbox", () => {
  test.skip(!enabled, "Set STRIPE_E2E=1 with Stripe test-mode keys to run against the sandbox");
  test.setTimeout(120_000);

  const stripe = () => new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

  async function orderAndOpenStripe(page: Page) {
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: /Ajouter au panier/ }).click();
    await page.goto("/fr/checkout");
    await choosePickupTime(page);
    await page.getByLabel("Nom pour l’appel au comptoir").fill("Sandbox");
    await page.getByLabel("Courriel pour le reçu").fill("sandbox@example.test");
    await page.getByRole("button", { name: "Commander et payer" }).click();
    await page.waitForURL(/\/checkout\/pay\//);
    await page.getByRole("button", { name: /^Payer / }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  }

  async function payWithCard(page: Page, card: string) {
    await page.locator("#cardNumber").fill(card);
    await page.locator("#cardExpiry").fill("12 / 34");
    await page.locator("#cardCvc").fill("123");
    await page.locator("#billingName").fill("Sandbox Test");
    const postal = page.locator("#billingPostalCode");
    if (await postal.isVisible()) await postal.fill("H2T 1S6");
    await page.locator(".SubmitButton").click();
  }

  /** Pays with `card` and waits for the order page; returns the order id. */
  async function paidOrder(page: Page, card: string): Promise<string> {
    await orderAndOpenStripe(page);
    await payWithCard(page, card);
    await page.waitForURL(/\/orders\/[\w-]+/, { timeout: 60_000 });
    await expect(page.getByText("Payée", { exact: true })).toBeVisible();
    return /\/orders\/([\w-]+)/.exec(page.url())![1]!;
  }

  /**
   * Stripe's "3D Secure 2 Test Page" sits in nested frames: click its "Complete" button once the
   * page is ready, until the challenge goes away.
   */
  async function completeThreeDSecure(page: Page) {
    let clicked = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      let present = false;
      for (const frame of page.frames()) {
        if (frame.isDetached()) continue;
        const heading = frame.getByRole("heading", { name: /3D Secure 2/ });
        if (!(await heading.count().catch(() => 0))) continue;
        present = true;
        const done = await frame
          .getByRole("button", { name: "Complete", exact: true })
          .click({ timeout: 2000 })
          .then(() => true)
          .catch(() => false);
        if (done) clicked = true;
      }
      if (clicked && !present) return;
      await page.waitForTimeout(500);
    }
    throw new Error("The 3-D Secure challenge did not appear or did not close");
  }

  async function withDb<T>(task: (db: ReturnType<typeof createDb>["db"]) => Promise<T>) {
    const { db, close } = createDb(process.env.DATABASE_URL_E2E ?? "", { max: 1 });
    try {
      return await task(db);
    } finally {
      await close();
    }
  }

  /** Waits for Stripe events matching `match` (they can take a few seconds to be listed). */
  async function stripeEvents(types: string[], match: (e: Stripe.Event) => boolean) {
    const since = Math.floor(Date.now() / 1000) - 600;
    for (let attempt = 0; attempt < 30; attempt++) {
      const { data } = await stripe().events.list({ types, created: { gte: since }, limit: 100 });
      const found = data.filter(match);
      if (found.length) return found;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`No ${types.join("/")} event from Stripe`);
  }

  /** Delivers one event to the webhook endpoint exactly as Stripe (or `stripe listen`) would. */
  async function deliver(request: APIRequestContext, event: Stripe.Event) {
    const payload = JSON.stringify(event);
    const signature = stripe().webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    });
    const response = await request.post("/api/webhooks/stripe", {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as { received: boolean; duplicate: boolean };
  }

  test("a test card payment is confirmed by Stripe, not by the redirect", async ({ page }) => {
    await paidOrder(page, "4242424242424242");
    await expect(page.getByText(/visa •••• 4242/i)).toBeVisible();
  });

  test("a declined test card leaves the order unpaid", async ({ page }) => {
    await orderAndOpenStripe(page);
    await payWithCard(page, "4000000000000002");
    await expect(page.getByText(/declined|refusée/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("insufficient funds are refused on Stripe's page", async ({ page }) => {
    await orderAndOpenStripe(page);
    await payWithCard(page, "4000000000009995");
    await expect(page.getByText(/insufficient|insuffisant/i).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(page.url()).toMatch(/checkout\.stripe\.com/);
  });

  test("a 3-D Secure card is paid once the customer authenticates", async ({ page }) => {
    await orderAndOpenStripe(page);
    await payWithCard(page, "4000002760003184");
    await completeThreeDSecure(page);
    await page.waitForURL(/\/orders\/[\w-]+/, { timeout: 60_000 });
    await expect(page.getByText("Payée", { exact: true })).toBeVisible();
  });

  test.describe("refunds and webhooks", () => {
    /** A guest pays; the manager acts from a session of their own. */
    let manager: BrowserContext;
    test.beforeEach(async ({ browser }) => {
      manager = await browser.newContext({ storageState: "e2e/.auth/manager.json" });
    });
    test.afterEach(async () => {
      await manager.close();
    });

    /** Staff status change, with the version the staff screen would hold. */
    async function moveTo(orderId: string, to: string, reason?: string) {
      const order = await withDb(async (db) =>
        db.query.orders.findFirst({ where: eq(orders.id, orderId) }),
      );
      const response = await manager.request.post(`/api/v1/staff/orders/${orderId}/transition`, {
        data: { to, reason, expectedVersion: order!.version },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }

    /** Delivers Stripe's events for the order's refund and returns them. */
    async function settleRefund(request: APIRequestContext, orderId: string) {
      const refund = await withDb(async (db) =>
        db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) }),
      );
      expect(refund?.providerRefundId).toMatch(/^re_/);
      const events = await stripeEvents(
        ["refund.created", "refund.updated"],
        (e) => (e.data.object as Stripe.Refund).id === refund!.providerRefundId,
      );
      for (const event of events) await deliver(request, event);
      return events;
    }

    const paymentOf = (orderId: string) =>
      withDb(async (db) => db.query.payments.findFirst({ where: eq(payments.orderId, orderId) }));

    test("a partial refund of a completed order is settled by Stripe's webhook; a replay changes nothing", async ({
      page,
      request,
    }) => {
      const orderId = await paidOrder(page, "4242424242424242");
      for (const to of ["accepted", "in_preparation", "ready", "completed"])
        await moveTo(orderId, to);

      const refunded = await manager.request.post(`/api/v1/staff/orders/${orderId}/refund`, {
        data: { amountCents: 50, reason: "Sandbox partial refund" },
      });
      expect(refunded.ok(), await refunded.text()).toBe(true);
      const events = await settleRefund(request, orderId);
      const refund = await withDb(async (db) =>
        db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) }),
      );
      expect(refund?.status).toBe("succeeded");
      expect(await paymentOf(orderId)).toMatchObject({
        status: "partially_refunded",
        refundedCents: 50,
      });

      // The same event again (a provider retry or a dashboard "resend"): recorded as a duplicate.
      expect(await deliver(request, events[0]!)).toMatchObject({ duplicate: true });
      expect(await paymentOf(orderId)).toMatchObject({
        status: "partially_refunded",
        refundedCents: 50,
      });
    });

    test("cancelling a paid order refunds it in full through Stripe", async ({ page, request }) => {
      const orderId = await paidOrder(page, "4242424242424242");
      const paid = await paymentOf(orderId);
      await moveTo(orderId, "cancelled", "Sandbox: out of stock");
      await settleRefund(request, orderId);
      expect(await paymentOf(orderId)).toMatchObject({
        status: "refunded",
        refundedCents: paid!.amountCents,
      });
    });

    test("a chargeback on a real order shows up for staff follow-up", async ({ page, request }) => {
      // Stripe's dispute test card: the payment succeeds, then the cardholder disputes it.
      const orderId = await paidOrder(page, "4000000000000259");
      const payment = await withDb(async (db) =>
        db.query.payments.findFirst({ where: eq(payments.orderId, orderId) }),
      );
      const [created] = await stripeEvents(
        ["charge.dispute.created"],
        (e) => (e.data.object as Stripe.Dispute).payment_intent === payment!.providerPaymentId,
      );
      await deliver(request, created!);
      const dispute = await withDb(async (db) =>
        db.query.paymentDisputes.findFirst({ where: eq(paymentDisputes.orderId, orderId) }),
      );
      expect(dispute).toMatchObject({ paymentId: payment!.id, amountCents: payment!.amountCents });

      const staff = await manager.newPage();
      await staff.goto("/fr/staff/payments");
      await expect(staff.getByText("Litige ouvert").first()).toBeVisible();
    });
  });
});
