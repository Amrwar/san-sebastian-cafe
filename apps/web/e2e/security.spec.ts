import { expect, test, type Page } from "@playwright/test";

/** Visits each path and fails on any Content Security Policy violation or script error. */
async function expectCleanPages(page: Page, paths: string[]) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text()))
      problems.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${page.url()}: ${e.message}`));
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(problems).toEqual([]);
}

test.describe("content security policy", () => {
  test("pages carry a per-request nonce policy, and the app's own scripts run under it", async ({
    page,
    request,
  }) => {
    const first = await request.get("/fr/menu");
    const second = await request.get("/fr/menu");
    const csp = first.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[\w+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    // A fresh nonce each time.
    const nonce = (h: string) => /'nonce-([^']+)'/.exec(h)?.[1];
    expect(nonce(csp)).not.toBe(nonce(second.headers()["content-security-policy"] ?? ""));
    // The page's scripts carry that nonce.
    expect(await first.text()).toContain(`nonce="${nonce(csp)}"`);

    // API responses can't be rendered as documents.
    const api = await request.get("/api/health");
    expect(api.headers()["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );

    // Interactive pages work with no violation (menu, product customizer, cart, sign-in).
    await expectCleanPages(page, [
      "/fr",
      "/fr/menu",
      "/fr/menu/demo-latte",
      "/en/cart",
      "/fr/sign-in",
    ]);
    await page.goto("/fr/menu/demo-latte");
    await page.getByRole("button", { name: /^Ajouter au panier/ }).click();
    await expect(
      page
        .getByRole("status")
        .or(page.getByText(/ajouté/i))
        .first(),
    ).toBeVisible();
  });
});

test.describe("content security policy for staff screens", () => {
  test.use({ storageState: "e2e/.auth/manager.json" });

  test("the live queue, reports charts and admin forms run with no violation", async ({ page }) => {
    await expectCleanPages(page, [
      "/fr/staff",
      "/fr/admin/reports?demo=1",
      "/fr/admin/menu",
      "/fr/admin/promotions",
      "/fr/admin/privacy",
    ]);
    // The live stream connected under the policy.
    await page.goto("/fr/staff");
    await expect(page.getByText(/^En direct/)).toBeVisible();
  });
});
