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
