import { test as setup } from "@playwright/test";
import { signIn } from "./helpers";

/*
 * Signs each demo role in ONCE through the real passwordless flow and saves the session, so the
 * suites can reuse it without exceeding the (intentionally strict) sign-in rate limits.
 */
const DEMO = "demo.san-sebastian.invalid";

for (const role of ["customer", "staff", "manager"] as const) {
  setup(`sign in as demo ${role}`, async ({ page }) => {
    await signIn(page, `${role}@${DEMO}`, "fr");
    await page.context().storageState({ path: `e2e/.auth/${role}.json` });
  });
}
