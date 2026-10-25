import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, signIn } from "./helpers";

test.describe("a customer's own data", () => {
  test("downloads a copy of their data, then deletes their account", async ({ page }) => {
    const email = `privacy.${Date.now()}@example.test`;
    await signIn(page, email, "fr", "/fr/account/data");
    await page.getByLabel("Nom").fill("Camille Roy");
    await page.getByRole("button", { name: "Terminer" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Mes données" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // A copy of everything, as JSON.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Télécharger (JSON)" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^san-sebastian-cafe-donnees-\d{4}-\d{2}-\d{2}\.json$/,
    );
    const data = JSON.parse(await readFile(await download.path(), "utf8")) as {
      format: string;
      account: { email: string; name: string };
    };
    expect(data.format).toBe("san-sebastian-cafe/personal-data@1");
    expect(data.account).toMatchObject({ email, name: "Camille Roy" });

    // Deleting needs the email typed again.
    await page.getByRole("button", { name: "Supprimer mon compte…" }).click();
    const confirm = page.getByRole("button", { name: "Supprimer définitivement" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Pour confirmer, tapez votre adresse courriel/).fill(email);
    await confirm.click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Votre compte a été supprimé" }),
    ).toBeVisible();

    // Signed out: the account area asks to sign in again.
    await page.goto("/fr/account");
    await expect(page).toHaveURL(/\/fr\/sign-in/);
  });
});

test.describe("privacy policy and terms", () => {
  test("are linked from every page, readable, and the site sets only essential cookies", async ({
    page,
    context,
  }) => {
    await page.goto("/fr");
    await page.getByRole("contentinfo").getByRole("link", { name: "Confidentialité" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Politique de confidentialité" }),
    ).toBeVisible();
    await expect(page.getByText(/Ébauche rédigée/)).toBeVisible();
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Témoins (cookies) et stockage dans le navigateur",
      }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("contentinfo").getByRole("link", { name: "Conditions" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Conditions d’utilisation et de vente" }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // Every cookie set while browsing is one the policy lists.
    await page.goto("/en/menu");
    const listed = ["ssc.session_token", "NEXT_LOCALE", "ssc_welcomed"];
    for (const cookie of await context.cookies())
      expect(
        listed.some((name) => cookie.name.endsWith(name)),
        cookie.name,
      ).toBe(true);
  });
});

test.describe("privacy administration", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  test("a manager names the privacy officer, logs and closes a request, and records an incident", async ({
    page,
  }) => {
    await page.goto("/fr/admin/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Confidentialité" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.getByLabel("Nom ou titre").fill("Propriétaire");
    await page.getByLabel("Courriel de contact").fill("vie.privee@example.test");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText("Responsable enregistré.")).toBeVisible();

    await page.getByRole("button", { name: "Consigner une demande" }).click();
    await page.getByLabel("Type de demande").selectOption("access");
    await page.getByLabel("Coordonnées de la personne").fill("514-555-0123");
    await page.getByRole("button", { name: "Consigner", exact: true }).click();
    await expect(page.getByText("Demande consignée.")).toBeVisible();
    const request = page.getByRole("listitem").filter({ hasText: "514-555-0123" });
    await expect(request.getByText("Ouverte")).toBeVisible();
    await request.getByRole("button", { name: "Clore" }).click();
    await request.getByLabel("Suite donnée").fill("Renseignements communiqués par téléphone.");
    await request.getByRole("button", { name: "Clore" }).click();
    await expect(page.getByText("Demande close.")).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "514-555-0123" })
        .getByText("Suite donnée : Renseignements communiqués par téléphone."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Consigner un incident" }).click();
    await page.getByLabel("Constaté le").fill("2026-10-20");
    await page.getByLabel("Description").fill("Une tablette du comptoir est restée déverrouillée.");
    await page.getByLabel("Renseignements touchés").fill("Prénoms de la file de commandes");
    await page.getByRole("button", { name: "Enregistrer l’incident" }).click();
    await expect(page.getByText("Incident enregistré.")).toBeVisible();
    await expect(page.getByText("Risque non évalué")).toBeVisible();

    // The published policy names the officer.
    await page.goto("/fr/privacy");
    await expect(page.getByRole("link", { name: "vie.privee@example.test" })).toBeVisible();
  });
});

test.describe("privacy administration access", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  test("baristas can't open it", async ({ page }) => {
    await page.goto("/fr/admin/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Confidentialité" })).toHaveCount(0);
  });
});
