import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

/*
 * Critical customer journeys, run on desktop AND phone (see playwright.config.ts).
 * Demo prices: latte Small 1,00 $ / Large 2,00 $, oat +1,00 $, vanilla +1,00 $, americano 1,00 $.
 * Taxes: GST 5 %, QST 9.975 % (each rounded half-up on the invoice).
 */

const money = (s: string) => new RegExp(s.replace(/\s/g, "\\s").replace("$", "\\$"));

function summaryTotal(page: Page) {
  return page.locator("dl").filter({ hasText: "Total" }).last();
}

async function addConfiguredLatte(page: Page) {
  await page.goto("/fr/menu?q=latte");
  await page.getByRole("link", { name: "[DÉMO] Latte" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "[DÉMO] Latte" })).toBeVisible();
  await page.getByRole("radio", { name: /^Grand/ }).check();
  await page.getByRole("radio", { name: /^Boisson d’avoine/ }).check();
  await page.getByRole("checkbox", { name: /^Vanille/ }).check();
  await page.getByRole("button", { name: money("Ajouter au panier · 4,00 $") }).click();
  await expect(page.getByText("Ajouté à votre panier.")).toBeVisible();
}

test.describe("menu → customize → cart", () => {
  test("customizes a drink from menu configuration and edits it in the cart", async ({ page }) => {
    await addConfiguredLatte(page);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("link", { name: "Voir le panier" }).click();
    await expect(page).toHaveURL(/\/fr\/cart$/);
    const line = page.getByRole("article").filter({ hasText: "[DÉMO] Latte" });
    await expect(line).toContainText("Grand · Chaud · Boisson d’avoine · Vanille");
    await expect(line).toContainText(money("4,00 $"));
    await expect(summaryTotal(page)).toContainText(money("4,60 $")); // 400 + 20 + 40
    await expectNoSeriousA11yViolations(page);

    await line.getByRole("button", { name: "Augmenter la quantité" }).click();
    await expect(summaryTotal(page)).toContainText(money("9,20 $")); // 800 + 40 + 80

    await line.getByRole("link", { name: "Modifier" }).click();
    await page.getByRole("radio", { name: /^Petit/ }).check();
    await page.getByRole("button", { name: money("Mettre à jour · 6,00 $") }).click();
    await expect(page.getByText("Article mis à jour.")).toBeVisible();
    await page.goto("/fr/cart");
    await expect(page.getByRole("article").filter({ hasText: "[DÉMO] Latte" })).toContainText(
      money("6,00 $"),
    );

    await page.getByRole("button", { name: "Retirer [DÉMO] Latte" }).click();
    await expect(page.getByText("Votre panier est vide")).toBeVisible();
  });

  test("sold-out products cannot be added", async ({ page }) => {
    await page.goto("/fr/menu/demo-croissant");
    await expect(page.getByText("Ce produit n’est pas disponible pour le moment.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Ajouter au panier/ })).toHaveCount(0);
  });

  test("search finds products in either language and explains empty results", async ({ page }) => {
    await page.goto("/en/menu");
    await page.getByRole("searchbox", { name: "Search the menu" }).fill("muffin");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("1 product found")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search the menu" }).fill("zzzz");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("No products match “zzzz”.")).toBeVisible();
  });
});

test.describe("checkout review (payment not yet available)", () => {
  test("guests must provide contact details; a valid review succeeds but placing the order stays disabled", async ({
    page,
  }) => {
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: money("Ajouter au panier · 1,00 $") }).click();
    await page.goto("/fr/checkout");
    await expect(
      page.getByRole("heading", { level: 1, name: "Finaliser la commande" }),
    ).toBeVisible();

    // Delivery isn't offered: shown but disabled, with the reason.
    await expect(page.getByRole("radio", { name: /^Livraison/ })).toBeDisabled();

    // Pickup time from the (demo) opening hours.
    const asap = page.getByRole("radio", { name: /^Dès que possible/ });
    if (await asap.isDisabled()) {
      await page.getByRole("radio", { name: /^Choisir une heure/ }).check();
      await page.getByLabel("Heure").selectOption({ index: 1 });
    }

    // Tip suggestions are computed on the pre-tax amount (1,00 $ → 15 % = 0,15 $).
    await page.getByRole("radio", { name: /^15 %/ }).check();
    await expect(summaryTotal(page)).toContainText(money("1,30 $")); // 100 + 5 + 10 + 15

    await page.getByRole("button", { name: "Vérifier ma commande" }).click();
    await expect(page.getByText("Entrez un nom.")).toBeVisible();
    await expect(page.getByText("Entrez une adresse courriel valide.")).toBeVisible();

    await page.getByLabel("Nom pour la commande").fill("Alex");
    await page.getByLabel("Courriel pour le reçu").fill("alex@example.test");
    await page.getByRole("button", { name: "Vérifier ma commande" }).click();
    await expect(page.getByText(/Tout est en ordre/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Commander et payer" })).toBeDisabled();
    await expect(
      page.getByRole("note").getByText("Paiement en ligne pas encore offert"),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("network failures", () => {
  test("a failed price check shows a retry that recovers; a slow one says so", async ({ page }) => {
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: /Ajouter au panier/ }).click();

    await page.route("**/api/v1/cart/quote", (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.goto("/fr/cart");
    await expect(page.getByText("Une erreur est survenue de notre côté.")).toBeVisible();

    await page.unroute("**/api/v1/cart/quote");
    await page.route("**/api/v1/cart/quote", async (route) => {
      await new Promise((r) => setTimeout(r, 3500));
      await route.continue();
    });
    await page.getByRole("button", { name: "Réessayer" }).click();
    await expect(page.getByText(/La connexion semble lente/)).toBeVisible();
    await expect(summaryTotal(page)).toContainText(money("1,15 $"), { timeout: 15_000 });
  });
});

test.describe("first visit", () => {
  test("the welcome introduction runs once and can be skipped", async ({ page }) => {
    await page.goto("/fr");
    await page.getByRole("link", { name: "Commencer" }).click();
    await expect(page.getByText("Étape 1 sur 3")).toBeVisible();
    await page.getByRole("button", { name: "Suivant" }).click();
    await expect(
      page.getByRole("heading", { name: "Une carte de fidélité sans carton" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Suivant" }).click();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("link", { name: "Voir le menu" }).last().click();
    await expect(page).toHaveURL(/\/fr\/menu$/);
    await page.goto("/fr");
    await expect(page.getByText("Première visite?")).toHaveCount(0);
  });
});

test.describe("signed-in customer", () => {
  test.use({ storageState: "e2e/.auth/customer.json" });

  test("sees the stamp card, rewards wallet and history from the ledger", async ({ page }) => {
    await page.goto("/fr/rewards");
    await expect(
      page.getByRole("list", { name: "Carte de fidélité : 2 tampons sur 5" }),
    ).toBeVisible();
    await expect(
      page.getByText("Encore 3 tampons avant votre prochaine boisson gratuite"),
    ).toBeVisible();
    await expect(page.getByText("Boisson gratuite", { exact: true })).toBeVisible();
    await expect(page.getByText("Échangé contre une boisson gratuite")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("tracks an order in progress and reorders a past one", async ({ page }) => {
    await page.goto("/fr/orders");
    await page.getByRole("link", { name: "Voir la commande D-1002" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Commande D-1002" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toContainText("En préparation");
    await expect(page.getByText(/Mise à jour automatique/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("button", { name: "Commander de nouveau" }).click();
    await expect(page).toHaveURL(/\/fr\/cart$/);
    await expect(page.getByRole("article").filter({ hasText: "[DÉMO] Americano" })).toBeVisible();
  });

  test("uses a free drink in the cart and adds a favourite", async ({ page }) => {
    await page.goto("/fr/favorites");
    const favourite = page.getByRole("article").filter({ hasText: "[DÉMO] Latte" });
    await expect(favourite).toContainText("Boisson d’avoine");
    await favourite.getByRole("button", { name: "Ajouter au panier" }).click();
    await expect(page.getByText("[DÉMO] Latte a été ajouté au panier.")).toBeVisible();

    await page.goto("/fr/cart");
    await page.getByLabel("Utiliser une boisson gratuite").check();
    const summary = summaryTotal(page);
    await expect(summary).toContainText("Boisson gratuite");
    // Large latte 2,00 $ free; oat (+1,00 $) still charged → 100 + 5 + 10.
    await expect(summary).toContainText(money("1,15 $"));
  });
});
