import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Fails on serious or critical WCAG 2.x A/AA violations. */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  // After a client-side navigation Next.js swaps <title> asynchronously; scan the settled page.
  // (A page that never gets a title still fails here.)
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    "accessibility violations",
  ).toEqual([]);
}

/** Reads the sign-in code the development "console" mail transport captured for `email`. */
export async function readSignInCode(email: string): Promise<string> {
  const file = join(
    process.cwd(),
    ".dev-mail",
    `${email.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.json`,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const message = JSON.parse(await readFile(file, "utf8")) as { meta?: { otp?: string } };
      if (message.meta?.otp) return message.meta.otp;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No sign-in code captured for ${email}: ${String(lastError)}`);
}

export async function signIn(
  page: Page,
  email: string,
  locale: "fr" | "en" = "fr",
  next?: string,
): Promise<void> {
  const labels =
    locale === "fr"
      ? {
          email: "Adresse courriel",
          send: "Recevoir un code",
          code: "Code de vérification",
          verify: "Se connecter",
        }
      : {
          email: "Email address",
          send: "Send me a code",
          code: "Verification code",
          verify: "Sign in",
        };
  await page.goto(`/${locale}/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  await page.getByLabel(labels.email).fill(email);
  await page.getByRole("button", { name: labels.send }).click();
  const code = await readSignInCode(email);
  await page.getByLabel(labels.code).fill(code);
  await page.getByRole("button", { name: labels.verify, exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"));
}

/** Empties the signed-in customer's saved cart so tests don't inherit each other's lines. */
export async function clearSavedCart(page: Page): Promise<void> {
  const response = await page.request.put("/api/v1/me/cart", { data: { lines: [] } });
  expect(response.ok()).toBe(true);
}

/** Picks ASAP when the (demo) hours allow it right now, otherwise the first offered time slot. */
export async function choosePickupTime(page: Page): Promise<void> {
  const asap = page.getByRole("radio", { name: /^Dès que possible/ });
  await expect(asap).toBeVisible();
  if (await asap.isDisabled()) {
    await page.getByRole("radio", { name: /^Choisir une heure/ }).check();
    await page.getByLabel("Heure", { exact: true }).selectOption({ index: 1 });
  } else {
    await asap.check();
  }
}
