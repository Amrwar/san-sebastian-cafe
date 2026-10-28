import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

/** Subjects of the order emails the development transport wrote for `email`. */
async function subjectsTo(email: string): Promise<string[]> {
  const dir = join(process.cwd(), ".dev-mail");
  const prefix = `${email.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__`;
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(prefix)).sort();
  return Promise.all(
    files.map(
      async (f) =>
        (JSON.parse(await readFile(join(dir, f), "utf8")) as { subject: string }).subject,
    ),
  );
}

/** Switches the zone off again, so the rest of the suite sees pickup only. */
async function switchOff(admin: Page, name: string) {
  await admin.goto("/fr/admin/delivery");
  await admin.getByRole("button", { name: `Modifier ${name}` }).click();
  await admin.getByLabel("Zone activée").uncheck();
  await admin.getByRole("button", { name: "Enregistrer la zone" }).click();
  await expect(admin.getByText("Zone enregistrée.")).toBeVisible();
}

test("a manager opens a delivery zone; a guest orders delivery; staff hand it to the courier and mark it delivered", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const name = `Mile End ${Date.now()}`;
  const email = `delivery.${Date.now()}@example.test`;
  const managerContext = await browser.newContext({ storageState: "e2e/.auth/manager.json" });
  const staffContext = await browser.newContext({ storageState: "e2e/.auth/staff.json" });
  const admin = await managerContext.newPage();
  let opened = false;
  try {
    // 1. The manager adds a zone and switches it on.
    await admin.goto("/fr/admin/delivery");
    await expect(admin.getByRole("heading", { level: 1, name: "Livraison" })).toBeVisible();
    await expect(admin.getByText("La livraison n’est pas offerte")).toBeVisible();
    await admin.getByRole("button", { name: "Ajouter une zone" }).click();
    await admin.getByLabel("Nom (français)").fill(name);
    await admin.getByLabel("Nom (anglais)").fill(name);
    await admin.getByLabel("Débuts de code postal").fill("h2t, H2V");
    await admin.getByLabel("Frais de livraison ($)").fill("3");
    await admin.getByLabel("Temps de route (min)").fill("20");
    await admin.getByLabel("Zone activée").check();
    await admin.getByRole("button", { name: "Enregistrer la zone" }).click();
    await expect(admin.getByText("Zone enregistrée.")).toBeVisible();
    opened = true;
    await expect(admin.getByText("La livraison est offerte")).toBeVisible();
    await expectNoSeriousA11yViolations(admin);

    // 2. A guest orders an Americano for delivery.
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: /^Ajouter au panier/ }).click();
    await page.goto("/fr/checkout");
    await page.getByRole("radio", { name: /^Livraison/ }).check();
    await page.getByLabel("Adresse").fill("5555 av. du Parc");
    await page.getByLabel("Code postal").fill("H2T 1S6");
    await expect(page.getByText(`Livraison offerte : ${name}, environ 20 min.`)).toBeVisible();
    await page.getByLabel("Instructions de livraison").fill("Sonnez deux fois");
    await page.getByLabel("Nom pour l’appel au comptoir").fill("Sam");
    await page.getByLabel("Courriel pour le reçu").fill(email);
    // The courier must be able to call.
    await page.getByRole("button", { name: "Commander et payer" }).click();
    await expect(page.getByText("Entrez un numéro de téléphone")).toBeVisible();
    await page.getByLabel("Téléphone (pour le livreur)").fill("514 555-0199");
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Commander et payer" }).click();
    await page.waitForURL(/\/fr\/checkout\/pay\/[\w-]+\?token=/);
    const heading = page.getByRole("heading", { level: 1, name: /^Payer la commande / });
    const number = (await heading.textContent())?.replace("Payer la commande ", "").trim() ?? "";
    await page.getByRole("button", { name: "Simuler un paiement accepté" }).click();
    await page.waitForURL(/\/fr\/orders\/[\w-]+\?token=/);
    await expect(page.getByText(/^Livraison prévue vers/)).toBeVisible();

    // 3. The counter sees where it goes, then hands it to the courier.
    const counter = await staffContext.newPage();
    await counter.goto("/fr/staff");
    const card = counter.getByRole("article", { name: number });
    await expect(card).toContainText("5555 av. du Parc");
    await expect(card).toContainText("Sonnez deux fois");
    await expect(card.getByRole("link", { name: "514 555-0199" })).toHaveAttribute(
      "href",
      "tel:5145550199",
    );
    await card.getByRole("button", { name: "Accepter", exact: true }).click();
    await card.getByRole("button", { name: "Commencer", exact: true }).click();
    await card.getByRole("button", { name: "Prête", exact: true }).click();
    // Ready for a delivery means waiting for the courier, not "come to the counter".
    await card.getByRole("button", { name: "Remise au livreur", exact: true }).click();
    await expect(page.getByText("Votre commande est en route!")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Votre commande est prête!")).toHaveCount(0);
    await expectNoSeriousA11yViolations(counter);

    await card.getByRole("button", { name: "Livrée", exact: true }).click();
    await expect(counter.getByRole("article", { name: number })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Livrée").first()).toBeVisible();

    // The customer was told it was on its way (and never asked to come and get it).
    await expect
      .poll(async () => (await subjectsTo(email)).join(" | "), { timeout: 15_000 })
      .toContain(`Votre commande ${number} est en route`);
    expect((await subjectsTo(email)).join(" | ")).not.toContain("est prête");
  } finally {
    if (opened) await switchOff(admin, name);
    await managerContext.close();
    await staffContext.close();
  }
});
