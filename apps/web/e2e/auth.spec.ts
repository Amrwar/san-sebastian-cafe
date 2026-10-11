import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, signIn } from "./helpers";

test.describe("passwordless sign-up, onboarding and account", () => {
  test("a new customer signs up with an emailed code, completes onboarding and manages preferences", async ({
    page,
  }) => {
    const email = `new.customer.${Date.now()}@example.test`;

    // A protected page sends anonymous visitors to sign-in and back afterwards.
    await page.goto("/fr/account");
    await expect(page).toHaveURL(/\/fr\/sign-in\?next=%2Ffr%2Faccount$/);

    await signIn(page, email, "fr", "/fr/account");
    // First sign-in → onboarding (name, language, communications), then back to the target.
    await expect(page).toHaveURL(/\/fr\/onboarding/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Faisons connaissance" }),
    ).toBeVisible();
    // Marketing consent is off by default (privacy by default).
    await expect(page.getByLabel(/J’accepte de recevoir des offres/)).not.toBeChecked();
    await expectNoSeriousA11yViolations(page);
    await page.getByLabel("Nom").fill("Marie Tremblay");
    await page.getByRole("button", { name: "Terminer" }).click();

    await expect(page).toHaveURL(/\/fr\/account$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Bonjour, Marie Tremblay" }),
    ).toBeVisible();
    await expect(page.getByText(`Connecté en tant que ${email}`)).toBeVisible();

    // Profile page: language only (communications live on their own page).
    await page.getByLabel("Langue de communication").selectOption("en-CA");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Vos préférences ont été enregistrées.")).toBeVisible();

    await page.getByRole("link", { name: "Communications" }).click();
    await expect(page).toHaveURL(/\/fr\/account\/notifications$/);
    await page.getByLabel(/J’accepte de recevoir des offres/).check();
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Vos préférences ont été enregistrées.")).toBeVisible();
    // Channels that don't exist yet are labelled, not faked.
    await expect(page.getByText("Pas encore offert", { exact: true })).toHaveCount(2);
    await expectNoSeriousA11yViolations(page);

    const api = await page.request.get("/api/v1/me/settings");
    expect(await api.json()).toMatchObject({
      name: "Marie Tremblay",
      preferredLocale: "en-CA",
      marketingEmail: true,
    });

    await page.goto("/fr/account");
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/fr$/);
  });

  test("a wrong code is rejected with a clear message", async ({ page }) => {
    await page.goto("/en/sign-in");
    await page.getByLabel("Email address").fill(`wrong.code.${Date.now()}@example.test`);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That code is invalid or has expired.")).toBeVisible();
  });

  test("registration wording and account recovery help are available", async ({ page }) => {
    await page.goto("/fr/sign-in?mode=register");
    await expect(page.getByRole("heading", { level: 1, name: "Créer un compte" })).toBeVisible();
    await page.getByRole("link", { name: "Problème pour vous connecter?" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Récupérer l’accès à votre compte" }),
    ).toBeVisible();
    await page.getByText("Je n’ai plus accès à mon courriel").click();
    await expect(page.getByText(/Présentez-vous au comptoir/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("role-based access", () => {
  test.describe("customer", () => {
    test.use({ storageState: "e2e/.auth/customer.json" });
    test("cannot open the staff console", async ({ page }) => {
      await page.goto("/en/staff");
      await expect(page.getByRole("heading", { level: 1, name: "Restricted area" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Staff", exact: true })).toHaveCount(0);
    });
  });

  test.describe("staff", () => {
    test.use({ storageState: "e2e/.auth/staff.json" });
    test("see the staff console but not administration", async ({ page }) => {
      await page.goto("/en/staff");
      await expect(page.getByRole("heading", { level: 1, name: "Order queue" })).toBeVisible();
      await expect(page.getByRole("region", { name: /^Preparing/ })).toContainText("D-1002");
      await expectNoSeriousA11yViolations(page);
      await page.goto("/en/admin");
      await expect(page.getByRole("heading", { level: 1, name: "Restricted area" })).toBeVisible();
    });
  });

  test.describe("manager", () => {
    test.use({ storageState: "e2e/.auth/manager.json" });
    test("sees administration with the demo-data warning", async ({ page }) => {
      await page.goto("/fr/admin");
      await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
      await expect(page.getByText(/produits de démonstration/)).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  });
});
