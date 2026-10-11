import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("staff product availability", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  test("taking a product off sale is reflected on the menu at once, and can be undone", async ({
    page,
    browser,
  }) => {
    await page.goto("/fr/staff/availability");
    await expect(
      page.getByRole("heading", { level: 1, name: "Disponibilité des produits" }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    const espresso = page.getByRole("group", { name: "[DÉMO] Espresso" });
    await espresso.getByRole("button", { name: "Épuisé" }).click();
    await expect(page.getByText("[DÉMO] Espresso : mis à jour.")).toBeVisible();
    await expect(espresso.getByRole("button", { name: "Épuisé" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A guest (no session) sees the product as unavailable and can't add it.
    const guest = await browser.newContext();
    try {
      const shopper = await guest.newPage();
      await shopper.goto("/fr/menu/demo-espresso");
      await expect(
        shopper.getByText("Ce produit n’est pas disponible pour le moment."),
      ).toBeVisible();
      await expect(shopper.getByRole("button", { name: /Ajouter au panier/ })).toHaveCount(0);

      // Back on sale.
      await espresso.getByRole("button", { name: "En vente" }).click();
      await expect(espresso.getByRole("button", { name: "En vente" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await shopper.reload();
      await expect(shopper.getByRole("button", { name: /Ajouter au panier/ })).toBeVisible();
    } finally {
      await guest.close();
    }
  });
});

test.describe("payments and refunds", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  test("a manager refunds part of a completed order, with the reason kept in the audit trail", async ({
    page,
  }) => {
    await page.goto("/fr/staff/payments?number=D-1001");
    await expect(
      page.getByRole("heading", { level: 1, name: "Paiements et remboursements" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "D-1001" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // The server refuses more than what is refundable; the form checks first.
    await page.getByLabel("Montant ($)").fill("999");
    await page.getByLabel("Raison (visible dans l’historique)").fill("Boisson froide");
    await page.getByRole("button", { name: "Rembourser" }).click();
    await expect(page.getByText(/Entrez un montant entre 0,01/)).toBeVisible();

    await page.getByLabel("Montant ($)").fill("0.50");
    await page.getByRole("button", { name: "Rembourser" }).click();
    await expect(page.getByText("Remboursement demandé (effectué).")).toBeVisible();
    await expect(page.getByText(/Boisson froide — par /)).toBeVisible();
  });

  test("staff without refund rights can't open the payments screen", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/staff.json" });
    try {
      const page = await context.newPage();
      await page.goto("/fr/staff/payments");
      await expect(page.getByRole("heading", { level: 1, name: "Accès réservé" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
