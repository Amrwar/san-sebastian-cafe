import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("localization and shell", () => {
  test("the root redirects to French, the default language", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-CA");
    await expect(page.getByRole("heading", { level: 1, name: "San Sebastian Café" })).toBeVisible();
  });

  test("the language switcher keeps the current page and switches every label", async ({
    page,
  }) => {
    await page.goto("/fr/menu");
    await expect(page.getByRole("heading", { level: 1, name: "Aperçu du menu" })).toBeVisible();
    await page.getByRole("link", { name: "Afficher le site en anglais" }).click();
    await expect(page).toHaveURL(/\/en\/menu$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-CA");
    await expect(page.getByRole("heading", { level: 1, name: "Menu preview" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  });

  test("the skip link moves keyboard users to the main content", async ({ page }) => {
    await page.goto("/en");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("unknown pages return a localized 404", async ({ page }) => {
    const response = await page.goto("/fr/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Page introuvable" })).toBeVisible();
  });

  for (const path of ["/fr", "/en", "/fr/menu", "/en/sign-in"]) {
    test(`${path} has no serious accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoSeriousA11yViolations(page);
    });
  }
});

test.describe("menu preview", () => {
  test("shows seeded demo products clearly labelled, with CAD prices and availability", async ({
    page,
  }) => {
    await page.goto("/fr/menu");
    await expect(
      page.getByRole("note").filter({ hasText: "produits de démonstration" }),
    ).toBeVisible();
    const latte = page.getByRole("listitem").filter({ hasText: "[DÉMO] Latte" });
    await expect(latte.getByText("Démo", { exact: true })).toBeVisible();
    await expect(latte.getByText(/À partir de 1,00\s\$/)).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "[DÉMO] Croissant" }).getByText("Épuisé"),
    ).toBeVisible();
    // No ordering controls exist yet: nothing on the page claims you can order.
    await expect(page.getByRole("button", { name: /ajouter|commander/i })).toHaveCount(0);
  });

  test("formats prices for English Canada", async ({ page }) => {
    await page.goto("/en/menu");
    await expect(page.getByText("From $1.00").first()).toBeVisible();
  });
});

test.describe("HTTP API", () => {
  test("health reports database readiness with a request id", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
    expect(response.headers()["x-request-id"]).toBeTruthy();
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("menu API returns the public catalog", async ({ request }) => {
    const response = await request.get("/api/v1/menu");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      currency: string;
      categories: Array<{ products: unknown[] }>;
    };
    expect(body.currency).toBe("CAD");
    expect(body.categories.length).toBeGreaterThan(0);
  });

  test("protected API rejects anonymous callers with an RFC 9457 problem", async ({ request }) => {
    const response = await request.get("/api/v1/me/settings");
    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"]).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 401, code: "unauthenticated" });
  });
});
