import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("admin menu", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  test("a manager adds a category and a product, edits its price, then archives it", async ({
    page,
    browser,
  }) => {
    await page.goto("/fr/admin/menu");
    await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // New category.
    await page.getByRole("button", { name: "Nouvelle catégorie" }).click();
    await page.getByLabel("Nom (français)").fill("Thés E2E");
    await page.getByLabel("Nom (anglais)").fill("Teas E2E");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    const category = page.locator("section, div").filter({
      has: page.getByRole("heading", { level: 2, name: "Thés E2E" }),
    });
    await expect(page.getByRole("heading", { level: 2, name: "Thés E2E" })).toBeVisible();

    // New product in it.
    await category.getByRole("link", { name: "Nouveau produit" }).last().click();
    await expect(page.getByRole("heading", { level: 1, name: "Nouveau produit" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByLabel("Nom (français)").fill("Thé chai E2E");
    await page.getByLabel("Nom (anglais)").fill("Chai tea E2E");
    await page.getByLabel("Format (français)").fill("Régulier");
    await page.getByLabel("Format (anglais)").fill("Regular");
    await page.getByLabel("Prix ($, avant taxes)").fill("4.25");
    await page.getByRole("button", { name: "Enregistrer le produit" }).click();
    await expect(page.getByText("Produit créé.")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Modifier Thé chai E2E" }),
    ).toBeVisible();

    // Customers see it at once.
    const guest = await browser.newContext();
    try {
      const shopper = await guest.newPage();
      await shopper.goto("/fr/menu/the-chai-e2e");
      await expect(shopper.getByRole("heading", { level: 1, name: "Thé chai E2E" })).toBeVisible();
      await expect(shopper.getByText(/4,25\s\$/).first()).toBeVisible();

      // A new price applies from now on.
      await page.getByLabel("Prix ($, avant taxes)").fill("4.50");
      await page.getByRole("button", { name: "Enregistrer le produit" }).click();
      await expect(page.getByText("Produit enregistré.")).toBeVisible();
      await shopper.reload();
      await expect(shopper.getByText(/4,50\s\$/).first()).toBeVisible();

      // Archived: off the menu.
      await page.getByRole("link", { name: "Retour au menu" }).click();
      const row = page.getByRole("listitem").filter({
        has: page.getByRole("link", { name: "Thé chai E2E" }),
      });
      await row.getByRole("button", { name: "Archiver" }).click();
      await row.getByRole("button", { name: "Confirmer" }).click();
      await expect(page.getByRole("link", { name: "Thé chai E2E" })).toHaveCount(0);
      await shopper.reload();
      await expect(shopper.getByRole("heading", { level: 1, name: "Thé chai E2E" })).toHaveCount(0);
    } finally {
      await guest.close();
    }
  });

  test("option groups list where each is used", async ({ page }) => {
    await page.goto("/fr/admin/menu/options");
    await expect(page.getByRole("heading", { level: 1, name: "Groupes d’options" })).toBeVisible();
    await expect(page.getByText(/Utilisé par \d+ produits?/).first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("store settings", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  // Other specs share this database and need the café open: only a far-off closure is added.
  test("a manager closes a future date and reopens it", async ({ page }) => {
    await page.goto("/fr/admin/store");
    await expect(page.getByRole("heading", { level: 1, name: "Réglages du café" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Heures d’ouverture" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Date").fill(day);
    await page.getByLabel("Motif (français)").fill("Inventaire E2E");
    await page.getByRole("button", { name: "Fermer ce jour" }).click();
    await expect(page.getByText("Enregistré.")).toBeVisible();
    await expect(page.getByText(/Inventaire E2E/)).toBeVisible();

    await page.getByRole("button", { name: /^Rouvrir/ }).click();
    await expect(page.getByText(/Inventaire E2E/)).toHaveCount(0);
  });
});

test.describe("admin access", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  test("baristas can't open menu administration", async ({ page }) => {
    await page.goto("/fr/admin/menu");
    await expect(page.getByRole("heading", { level: 1, name: "Menu" })).toHaveCount(0);
  });
});
