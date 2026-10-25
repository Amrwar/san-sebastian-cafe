import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { choosePickupTime, expectNoSeriousA11yViolations } from "./helpers";

/** Faster than the 10 s polling fallback: only the live stream can be this quick. */
const LIVE = { timeout: 6_000 };

/** The order emails the development transport wrote for `email`, newest last. */
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

/** A guest orders an Americano and pays in the simulator; returns the order number. */
async function guestOrder(page: Page, email: string): Promise<string> {
  await page.goto("/fr/menu/demo-americano");
  await page.getByRole("button", { name: /^Ajouter au panier/ }).click();
  await page.goto("/fr/checkout");
  await choosePickupTime(page);
  await page.getByLabel("Nom pour l’appel au comptoir").fill("Sam");
  await page.getByLabel("Courriel pour le reçu").fill(email);
  await page.getByRole("button", { name: "Commander et payer" }).click();
  await page.waitForURL(/\/fr\/checkout\/pay\/[\w-]+\?token=/);
  const heading = page.getByRole("heading", { level: 1, name: /^Payer la commande / });
  const number = (await heading.textContent())?.replace("Payer la commande ", "").trim() ?? "";
  await page.getByRole("button", { name: "Simuler un paiement accepté" }).click();
  await page.waitForURL(/\/fr\/orders\/[\w-]+\?token=/);
  return number;
}

test.describe("live queue on the counter tablet", () => {
  test("a new order appears on the open queue within seconds, and the customer sees each step live", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const email = `live.${Date.now()}@example.test`;
    const staff = await browser.newContext({
      storageState: "e2e/.auth/staff.json",
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
    });
    try {
      // The tablet is already showing the queue when the order comes in.
      const counter = await staff.newPage();
      await counter.goto("/fr/staff");
      await expect(counter.getByText(/^En direct/)).toBeVisible();
      await expectNoSeriousA11yViolations(counter);

      const number = await guestOrder(page, email);
      const card = counter.getByRole("article", { name: number });
      await expect(card).toBeVisible(LIVE);
      await expect(card).toContainText("Sam");

      // Each step reaches the customer's tracking page without a reload.
      await card.getByRole("button", { name: "Accepter", exact: true }).click();
      await card.getByRole("button", { name: "Commencer", exact: true }).click();
      await expect(page.locator('[aria-current="step"]')).toContainText("En préparation", LIVE);
      await card.getByRole("button", { name: "Prête", exact: true }).click();
      await expect(page.getByText("Votre commande est prête!")).toBeVisible(LIVE);

      // The guest got a confirmation email, then a "ready" email (sent right after each change).
      await expect
        .poll(async () => (await emailsTo(email)).map((m) => m.subject), { timeout: 10_000 })
        .toEqual([`Commande ${number} confirmée`, `Votre commande ${number} est prête`]);
      const [confirmation] = await emailsTo(email);
      expect(confirmation!.text).toContain("parce que vous avez passé cette commande");
    } finally {
      await staff.close();
    }
  });
});
