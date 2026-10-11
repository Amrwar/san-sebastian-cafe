import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

// Runs in the "mobile" project (Pixel 7 viewport) and the desktop project.
test.describe("responsive navigation", () => {
  test("no horizontal scrolling on primary pages", async ({ page }) => {
    for (const path of ["/fr", "/fr/menu", "/fr/sign-in"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("the menu toggle is keyboard and screen-reader operable on small screens", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "The disclosure toggle only exists on small screens");
    await page.goto("/fr");
    const toggle = page.getByRole("button", { name: "Ouvrir le menu" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Fermer le menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByRole("link", { name: "Menu", exact: true }).last()).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.getByRole("link", { name: "Menu", exact: true }).last().click();
    await expect(page).toHaveURL(/\/fr\/menu$/);
    await expect(page.getByRole("button", { name: "Ouvrir le menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
