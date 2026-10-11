import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("responsive layout and navigation", () => {
  test("no horizontal scrolling on primary pages", async ({ page }) => {
    for (const path of [
      "/fr",
      "/fr/menu",
      "/fr/menu/demo-latte",
      "/fr/cart",
      "/fr/checkout",
      "/fr/sign-in",
      "/fr/rewards",
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("phones get a bottom tab bar; desktops get the header navigation", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/fr/menu");
    const tabs = page.getByRole("navigation", { name: "Navigation de l’application" });
    const header = page.getByRole("navigation", { name: "Navigation principale" });
    if (isMobile) {
      await expect(tabs).toBeVisible();
      await expect(header).toBeHidden();
      await expect(tabs.getByRole("link")).toHaveCount(5);
      await expect(tabs.getByRole("link", { name: "Menu" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await tabs.getByRole("link", { name: "Fidélité" }).click();
      await expect(page).toHaveURL(/\/fr\/rewards$/);
      await expectNoSeriousA11yViolations(page);
    } else {
      await expect(header).toBeVisible();
      await expect(tabs).toBeHidden();
      await expect(header.getByRole("link", { name: "Menu" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });
});
