import { expect, test, type Page } from "@playwright/test";
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
 */
const enabled =
  process.env.STRIPE_E2E === "1" && /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");

test.describe("Stripe sandbox", () => {
  test.skip(!enabled, "Set STRIPE_E2E=1 with Stripe test-mode keys to run against the sandbox");
  test.setTimeout(120_000);

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

  test("a test card payment is confirmed by Stripe, not by the redirect", async ({ page }) => {
    await orderAndOpenStripe(page);
    await payWithCard(page, "4242424242424242");
    await page.waitForURL(/\/orders\/[\w-]+/, { timeout: 60_000 });
    await expect(page.getByText("Payée", { exact: true })).toBeVisible();
    await expect(page.getByText(/visa •••• 4242/i)).toBeVisible();
  });

  test("a declined test card leaves the order unpaid", async ({ page }) => {
    await orderAndOpenStripe(page);
    await payWithCard(page, "4000000000000002");
    await expect(page.getByText(/declined|refusée/i).first()).toBeVisible({ timeout: 30_000 });
  });
});
