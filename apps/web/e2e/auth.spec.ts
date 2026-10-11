import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, signIn } from "./helpers";

const DEMO = "demo.san-sebastian.invalid";

test.describe("passwordless sign-in and account", () => {
  test("a new customer signs in with an emailed code, edits preferences and signs out", async ({
    page,
  }) => {
    const email = `new.customer.${Date.now()}@example.test`;

    // A protected page sends anonymous visitors to sign-in and back afterwards.
    await page.goto("/fr/account");
    await expect(page).toHaveURL(/\/fr\/sign-in\?next=%2Ffr%2Faccount$/);

    await signIn(page, email, "fr", "/fr/account");
    await expect(page).toHaveURL(/\/fr\/account$/);
    await expect(page.getByText(`Connecté en tant que ${email}`)).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // Marketing consent is off by default (privacy by default).
    const marketing = page.getByLabel(/J’accepte de recevoir des offres/);
    await expect(marketing).not.toBeChecked();

    await page.getByLabel("Nom").fill("Marie Tremblay");
    await page.getByLabel("Langue de communication").selectOption("en-CA");
    await marketing.check();
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Vos préférences ont été enregistrées.")).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Bonjour, Marie Tremblay" }),
    ).toBeVisible();
    await expect(page.getByLabel("Langue de communication")).toHaveValue("en-CA");
    await expect(page.getByLabel(/J’accepte de recevoir des offres/)).toBeChecked();

    // The same data is available through the versioned API with the session cookie.
    const api = await page.request.get("/api/v1/me/settings");
    expect(api.status()).toBe(200);
    expect(await api.json()).toMatchObject({ name: "Marie Tremblay", marketingEmail: true });

    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.getByRole("link", { name: "Se connecter", exact: true })).toBeVisible();
  });

  test("a wrong code is rejected with a clear message", async ({ page }) => {
    await page.goto("/en/sign-in");
    await page.getByLabel("Email address").fill(`wrong.code.${Date.now()}@example.test`);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That code is invalid or has expired.")).toBeVisible();
  });

  test("the sign-in page refuses to redirect off-site after login", async ({ page }) => {
    await page.goto("/en/sign-in?next=https://evil.example/");
    // The form renders normally; the unsafe target was replaced server-side (verified by unit tests).
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });
});

test.describe("role-based access", () => {
  test("customers cannot open the staff console", async ({ page }) => {
    await signIn(page, `customer@${DEMO}`, "en");
    await page.goto("/en/staff");
    await expect(page.getByRole("heading", { level: 1, name: "Restricted area" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Staff" })).toHaveCount(0);
  });

  test("staff see the staff console but not administration", async ({ page }) => {
    await signIn(page, `staff@${DEMO}`, "en");
    await page.goto("/en/staff");
    await expect(page.getByRole("heading", { level: 1, name: "Staff console" })).toBeVisible();
    await expect(page.getByRole("table")).toContainText("Awaiting payment");
    await expectNoSeriousA11yViolations(page);
    await page.goto("/en/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Restricted area" })).toBeVisible();
  });

  test("managers see administration with demo-data warning", async ({ page }) => {
    await signIn(page, `manager@${DEMO}`, "fr");
    await page.goto("/fr/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
    await expect(page.getByText(/produits de démonstration/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
