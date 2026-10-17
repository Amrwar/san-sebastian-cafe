import { expect, test } from "@playwright/test";
import { DEMO_EMAIL_DOMAIN } from "@ssc/db/seed";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("loyalty at the counter", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  test("the customer shows their code, staff stamp the receipt, and a lead can cancel it", async ({
    page,
    browser,
  }) => {
    const customerContext = await browser.newContext({
      storageState: "e2e/.auth/customer.json",
    });
    try {
      // Customer: show the counter code.
      const customer = await customerContext.newPage();
      await customer.goto("/fr/rewards");
      await expect(
        customer.getByRole("heading", { level: 2, name: "Code pour le comptoir" }),
      ).toBeVisible();
      await customer.getByRole("button", { name: "Afficher mon code" }).click();
      const shown = customer.getByLabel(/^Votre code/);
      await expect(shown).toBeVisible();
      await expectNoSeriousA11yViolations(customer);
      const code = (await shown.innerText()).replace(/\s+/g, "");
      expect(code).toMatch(/^[2-9A-Z]{8}$/);

      // Staff: identify the customer and record a receipt with two drinks.
      await page.goto("/fr/staff/loyalty");
      await expect(page.getByRole("heading", { level: 1, name: "Fidélité" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByLabel("Code du client").fill(code.toLowerCase());
      await page.getByRole("button", { name: "Trouver" }).click();
      await expect(page.getByText(/^Demo · \d+ tampons sur 5/)).toBeVisible();
      await page.getByLabel("Numéro du reçu").fill("E2E-0001");
      await page.getByRole("button", { name: "Ajouter un", exact: true }).click();
      await page.getByRole("button", { name: "Enregistrer les tampons" }).click();
      await expect(page.getByText(/2 tampons ajoutés\. Solde : \d+\./)).toBeVisible();

      // The same receipt can't be stamped twice.
      await page.getByRole("button", { name: "Client suivant" }).click();
      await page.getByLabel("Code du client").fill(code);
      await page.getByRole("button", { name: "Trouver" }).click();
      await page.getByLabel("Numéro du reçu").fill("e2e 0001");
      await page.getByRole("button", { name: "Enregistrer les tampons" }).click();
      await expect(page.getByText("Ce reçu a déjà été enregistré.")).toBeVisible();

      // The customer sees the visit, explained.
      await customer.reload();
      await expect(customer.getByText("En café · reçu E2E0001", { exact: false })).toBeVisible();

      // A manager finds the card by email and cancels the visit with a reason.
      await page.goto("/fr/staff/loyalty");
      await page.getByLabel("Courriel ou code").fill(`customer@${DEMO_EMAIL_DOMAIN}`);
      await page.getByRole("button", { name: "Chercher" }).click();
      await expect(page).toHaveURL(/customer=/);
      await expect(page.getByText(`c•••@${DEMO_EMAIL_DOMAIN}`)).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole("button", { name: "Annuler cet achat" }).click();
      await page
        .getByLabel("Raison de l’annulation (visible par le client)")
        .fill("Mauvais client");
      await page.getByRole("button", { name: "Confirmer" }).click();
      await expect(page.getByText("Annulé : Mauvais client")).toBeVisible();

      await customer.reload();
      await expect(customer.getByText("Raison : Mauvais client")).toBeVisible();
    } finally {
      await customerContext.close();
    }
  });
});
