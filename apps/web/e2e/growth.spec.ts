import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, signIn } from "./helpers";

/** Emails the development transport wrote for `email` (not sign-in codes), oldest first. */
async function emailsTo(email: string): Promise<Array<{ subject: string; text: string }>> {
  const dir = join(process.cwd(), ".dev-mail");
  const prefix = `${email.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__`;
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(prefix)).sort();
  return Promise.all(
    files.map(
      async (f) =>
        JSON.parse(await readFile(join(dir, f), "utf8")) as { subject: string; text: string },
    ),
  );
}

test.describe("promotions", () => {
  test("a manager creates a promo code and a customer gets the discount in the cart", async ({
    page,
    browser,
  }) => {
    const manager = await browser.newContext({ storageState: "e2e/.auth/manager.json" });
    try {
      const admin = await manager.newPage();
      await admin.goto("/fr/admin/promotions");
      await expect(admin.getByRole("heading", { level: 1, name: "Promotions" })).toBeVisible();
      await admin.getByRole("button", { name: "Nouvelle promotion" }).click();
      await admin.getByLabel("Code").fill("e2e20");
      await admin.getByLabel("Nom (français)").fill("Essai E2E");
      await admin.getByLabel("Nom (anglais)").fill("E2E test");
      await admin.getByLabel("Rabais (%)").fill("20");
      await admin.getByRole("button", { name: "Enregistrer la promotion" }).click();
      await expect(admin.getByText("Promotion enregistrée.")).toBeVisible();
      const card = admin.getByRole("listitem").filter({ hasText: "E2E20" });
      await expect(card.getByText("En cours")).toBeVisible();
      await expect(card.getByText(/20 % de rabais/)).toBeVisible();
      await expectNoSeriousA11yViolations(admin);
    } finally {
      await manager.close();
    }

    // A guest uses it.
    await page.goto("/fr/menu/demo-americano");
    await page.getByRole("button", { name: /^Ajouter au panier/ }).click();
    await page.goto("/fr/cart");
    await page.getByLabel("Code promotionnel").fill("E2E20");
    await page.getByRole("button", { name: "Appliquer" }).click();
    await expect(page.getByText("Code appliqué.")).toBeVisible();
  });
});

test.describe("marketing email", () => {
  test("a consenting customer receives a campaign and unsubscribes in one click", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const email = `offers.${Date.now()}@example.test`;
    // Sign up, opting in to offers (never pre-ticked).
    await signIn(page, email, "fr", "/fr/account");
    await page.getByLabel("Nom").fill("Léa Roy");
    await page.getByLabel(/J’accepte de recevoir des offres/).check();
    await page.getByRole("button", { name: "Terminer" }).click();
    await expect(page).toHaveURL(/\/fr\/account$/);

    const manager = await browser.newContext({ storageState: "e2e/.auth/manager.json" });
    try {
      const admin = await manager.newPage();
      await admin.goto("/fr/admin/marketing");
      await expect(
        admin.getByRole("heading", { level: 1, name: "Courriels promotionnels" }),
      ).toBeVisible();
      await admin.getByLabel("Nom de l’entreprise").fill("San Sebastian Café");
      await admin
        .getByLabel("Adresse postale")
        .fill("123, rue Saint-Denis, Montréal (Québec) H2X 1K1");
      await admin.getByRole("button", { name: "Enregistrer", exact: true }).click();
      await expect(admin.getByText("Expéditeur enregistré.")).toBeVisible();

      await admin.getByRole("button", { name: "Nouvelle campagne" }).click();
      await admin.getByLabel("Objet (français)").fill("Latte à l’érable E2E");
      await admin.getByLabel("Objet (anglais)").fill("Maple latte E2E");
      await admin.getByLabel("Message (français)").fill("Venez goûter notre latte à l’érable.");
      await admin.getByLabel("Message (anglais)").fill("Come taste our maple latte.");
      await admin.getByRole("button", { name: "Enregistrer le brouillon" }).click();
      await expect(admin.getByText("Brouillon enregistré.")).toBeVisible();
      await expectNoSeriousA11yViolations(admin);

      const draft = admin.getByRole("listitem").filter({ hasText: "Latte à l’érable E2E" });
      await draft.getByRole("button", { name: "Envoyer…" }).click();
      await draft.getByRole("button", { name: /^Envoyer à \d+ clients?$/ }).click();
      await expect(admin.getByText(/^Campagne envoyée à \d+ clients?\.$/)).toBeVisible();
    } finally {
      await manager.close();
    }

    // The email: sender identified, and a working unsubscribe link.
    await expect
      .poll(async () => (await emailsTo(email)).map((m) => m.subject), { timeout: 15_000 })
      .toContain("Latte à l’érable E2E");
    const campaign = (await emailsTo(email)).find((m) => m.subject === "Latte à l’érable E2E")!;
    expect(campaign.text).toContain("123, rue Saint-Denis, Montréal (Québec) H2X 1K1");
    const link = /Se désabonner : (\S+)/.exec(campaign.text)?.[1] ?? "";
    expect(link).toMatch(/\/fr\/unsubscribe\?u=/);

    await page.goto(new URL(link).pathname + new URL(link).search);
    await expect(page.getByRole("heading", { level: 1, name: "Se désabonner" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Me désabonner" }).click();
    await expect(page.getByText(/vous êtes désabonné, dès maintenant/)).toBeVisible();

    await page.goto("/fr/account/notifications");
    await expect(page.getByLabel(/J’accepte de recevoir des offres/)).not.toBeChecked();
  });
});
