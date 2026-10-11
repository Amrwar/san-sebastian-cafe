import { expect, test, type Page } from "@playwright/test";
import { choosePickupTime, clearSavedCart, expectNoSeriousA11yViolations } from "./helpers";

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

test.describe("checkout → payment → café → ready", () => {
  test("a guest orders, pays in the development simulator and follows the order until it's ready", async ({
    page,
    browser,
  }) => {
    // Two browsers (customer + counter) and live tracking: longer than a single-page test.
    test.setTimeout(90_000);
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: money("Ajouter au panier · 1,00 $") }).click();
    await page.goto("/fr/checkout");
    await expect(
      page.getByRole("heading", { level: 1, name: "Finaliser la commande" }),
    ).toBeVisible();

    // Delivery isn't offered: shown but disabled, with the reason.
    await expect(page.getByRole("radio", { name: /^Livraison/ })).toBeDisabled();
    await choosePickupTime(page);

    // Tip suggestions are computed on the pre-tax amount (1,00 $ → 15 % = 0,15 $).
    await page.getByRole("radio", { name: /^15 %/ }).check();
    await expect(summaryTotal(page)).toContainText(money("1,30 $")); // 100 + 5 + 10 + 15

    // Guests must say who the order is for before anything is sent.
    await page.getByRole("button", { name: "Commander et payer" }).click();
    await expect(page.getByText("Entrez un nom.")).toBeVisible();
    await expect(page.getByText("Entrez une adresse courriel valide.")).toBeVisible();
    await expect(page).toHaveURL(/\/fr\/checkout$/);

    await page.getByLabel("Nom pour l’appel au comptoir").fill("Alex");
    await page.getByLabel("Courriel pour le reçu").fill("alex@example.test");
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Commander et payer" }).click();

    // Payment step: the order is held (awaiting payment) and the simulator is clearly labelled.
    await page.waitForURL(/\/fr\/checkout\/pay\/[\w-]+\?token=/);
    const heading = page.getByRole("heading", { level: 1, name: /^Payer la commande / });
    await expect(heading).toBeVisible();
    const number = (await heading.textContent())?.replace("Payer la commande ", "").trim() ?? "";
    expect(number).toMatch(/^\d{4}-\d{3}$/);
    await expect(page.getByText("Simulateur de paiement (développement)")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // A decline leaves the order unpaid and lets the customer try again.
    await page.getByRole("button", { name: "Simuler un paiement refusé" }).click();
    await expect(page.getByText("Paiement refusé. Vous pouvez réessayer.")).toBeVisible();
    await page.getByRole("button", { name: "Simuler un paiement accepté" }).click();

    // The guest follows the order through the private link (no account).
    await page.waitForURL(/\/fr\/orders\/[\w-]+\?token=/);
    await expect(page.getByRole("heading", { level: 1, name: `Commande ${number}` })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toContainText("Reçue");
    await expect(page.getByText("Conservez ce lien pour suivre votre commande.")).toBeVisible();
    // Payment recorded from the (simulated) provider, with a printable receipt.
    await expect(page.getByText(/Payé 1,30\s\$ par visa •••• 4242/)).toBeVisible();
    await page.getByRole("link", { name: "Voir le reçu" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: `Reçu — commande ${number}` }),
    ).toBeVisible();
    await expect(page.getByText(/No TPS : \[À FOURNIR\]/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.goBack();

    // Behind the counter: the order appears in the queue and moves through each station.
    // The counter runs on a landscape tablet (all four columns visible), whatever the customer uses.
    const staff = await browser.newContext({
      storageState: "e2e/.auth/staff.json",
      viewport: { width: 1180, height: 820 },
      isMobile: false,
      hasTouch: true,
    });
    try {
      const counter = await staff.newPage();
      await counter.goto("/fr/staff");
      const card = counter.getByRole("article", { name: number });
      await expect(card).toContainText("[DÉMO] Americano");
      await expect(card).toContainText("Alex");
      for (const action of ["Accepter", "Commencer", "Prête"]) {
        await card.getByRole("button", { name: action, exact: true }).click();
        await expect(card.getByRole("button", { name: action, exact: true })).toHaveCount(0);
      }

      // The customer's tracking page picks the change up on its own.
      await expect(page.getByText("Votre commande est prête!")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText(`Présentez-vous au comptoir avec le numéro ${number}.`),
      ).toBeVisible();

      await card.getByRole("button", { name: "Remise au client" }).click();
      await expect(counter.getByRole("article", { name: number })).toHaveCount(0);
      await expect(counter.getByRole("region", { name: "Remises récemment" })).toContainText(
        number,
      );
    } finally {
      await staff.close();
    }
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
  // The cart follows the account across devices, so start each test from an empty one.
  test.beforeEach(async ({ page }) => {
    await clearSavedCart(page);
  });

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

  test("pays for an order, then cancels it before the café accepts (refunded in full)", async ({
    page,
  }) => {
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: money("Ajouter au panier · 1,00 $") }).click();
    await page.goto("/fr/checkout");
    await choosePickupTime(page);
    await page.getByLabel("Nom pour l’appel au comptoir").fill("Camille");
    await page.getByRole("button", { name: "Commander et payer" }).click();
    await page.waitForURL(/\/fr\/checkout\/pay\//);
    await page.getByRole("button", { name: "Simuler un paiement accepté" }).click();
    await page.waitForURL(/\/fr\/orders\/[\w-]+/);

    await page.getByRole("button", { name: "Annuler la commande" }).click();
    const dialog = page.getByRole("dialog", { name: "Annuler cette commande?" });
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await dialog.getByRole("button", { name: "Annuler la commande" }).click();
    await expect(page.getByText("La commande a été annulée.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Annuler la commande" })).toHaveCount(0);
  });
});
