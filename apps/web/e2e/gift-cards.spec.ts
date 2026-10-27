import { expect, test } from "@playwright/test";
import { choosePickupTime, emailedGiftCardCode, expectNoSeriousA11yViolations } from "./helpers";

/* Amounts are written with a non-breaking space before "$" in French. */
const amount = (text: string) => new RegExp(text.replace(/ /g, "\\s").replace("$", "\\$"));

test("a card sold at the counter is checked online and pays for an order; staff see it used", async ({
  browser,
}) => {
  // A manager sells a 5 $ card at the counter.
  const counter = await browser.newContext({ storageState: "e2e/.auth/manager.json" });
  const guest = await browser.newContext();
  try {
    const desk = await counter.newPage();
    await desk.goto("/fr/staff/gift-cards");
    await expect(desk.getByRole("heading", { level: 1, name: "Cartes-cadeaux" })).toBeVisible();
    await desk.getByLabel("Montant ($)").first().fill("5");
    await desk.getByRole("button", { name: "Créer la carte" }).click();
    const code = (await desk.getByTestId("gift-card-code").textContent())?.trim() ?? "";
    expect(code).toMatch(/^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
    await expect(desk.getByText("il ne sera plus affiché")).toBeVisible();
    await expectNoSeriousA11yViolations(desk);

    // The customer checks the balance on the site (typed in lower case, without dashes).
    const shopper = await guest.newPage();
    await shopper.goto("/fr/gift-cards");
    await shopper.getByLabel("Code de la carte").fill(code.toLowerCase().replace(/-/g, ""));
    await shopper.getByRole("button", { name: "Vérifier" }).click();
    await expect(shopper.getByText(amount(`•••• ${code.slice(-4)} : 5,00 $`))).toBeVisible();
    await expect(shopper.getByText("sans date d’expiration", { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(shopper);

    // …then pays for an americano (1,15 $ with taxes) with it: nothing is left to pay by card.
    await shopper.goto("/fr/menu/demo-americano");
    await shopper.getByRole("button", { name: /Ajouter au panier/ }).click();
    await shopper.goto("/fr/checkout");
    await choosePickupTime(shopper);
    await shopper.getByLabel("Nom pour l’appel au comptoir").fill("Sam");
    await shopper.getByLabel("Courriel pour le reçu").fill("sam@example.test");
    await shopper.getByLabel("Code de carte-cadeau").fill(code);
    await shopper.getByRole("button", { name: "Appliquer" }).click();
    await expect(shopper.getByText(amount("solde : 5,00 $"))).toBeVisible();
    await expect(shopper.getByText("À payer par carte")).toBeVisible();
    await expectNoSeriousA11yViolations(shopper);
    await shopper.getByRole("button", { name: "Commander et payer" }).click();

    // Paid at once: straight to the order, with the gift card on it.
    await shopper.waitForURL(/\/fr\/orders\/[\w-]+\?token=/);
    const heading = shopper.getByRole("heading", { level: 1, name: /^Commande / });
    const number = (await heading.textContent())?.replace("Commande ", "").trim() ?? "";
    await expect(shopper.getByText("Carte-cadeau", { exact: true })).toBeVisible();

    // At the counter, the card shows what is left and the order it paid for.
    await desk.getByLabel("Code de la carte").fill(code);
    await desk.getByRole("button", { name: "Chercher" }).click();
    await expect(desk.getByText(amount("3,85 $")).first()).toBeVisible();
    await expect(desk.getByText(`Paiement — commande ${number}`)).toBeVisible();
  } finally {
    await counter.close();
    await guest.close();
  }
});

test("staff without the right role can't sell cards, and unknown codes are refused", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: "e2e/.auth/staff.json" });
  try {
    const page = await context.newPage();
    await page.goto("/fr/staff/gift-cards");
    await expect(page.getByRole("heading", { name: "Trouver une carte" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Créer la carte" })).toHaveCount(0);
    await page.getByLabel("Code de la carte").fill("AAAA-BBBB-CCCC-DDDD");
    await page.getByRole("button", { name: "Chercher" }).click();
    await expect(page.getByText("Aucune carte ne correspond à ce code.")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a guest buys a card online; the recipient gets the code by email and can use it", async ({
  page,
}) => {
  const recipient = `gift-${Date.now()}@example.test`;
  await page.goto("/fr/gift-cards");
  await page.getByRole("radio", { name: amount("25,00 $") }).check();
  await page.getByLabel("Pour (nom)").fill("Camille");
  await page.getByLabel("Courriel de la personne").fill(recipient);
  await page.getByLabel("Petit mot (facultatif)").fill("Bonne fête!");
  await page.getByLabel("De (votre nom)").fill("Robin");
  await page.getByLabel("Votre courriel").fill("robin@example.test");
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: amount("Payer 25,00 $") }).click();

  // The payment step (development simulator in place of Stripe's page).
  await page.waitForURL(/\/fr\/gift-cards\/purchase\/[\w-]+\?token=/);
  await expect(page.getByText("en attente du paiement")).toBeVisible();
  await page.getByRole("button", { name: "Simuler un paiement accepté" }).click();
  await expect(page.getByText("Merci! La carte est envoyée.")).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // The recipient's email holds the code, and the card works.
  const code = await emailedGiftCardCode(recipient);
  await page.goto("/fr/gift-cards");
  await page.getByLabel("Code de la carte").fill(code);
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(page.getByText(amount(`•••• ${code.slice(-4)} : 25,00 $`))).toBeVisible();
});
