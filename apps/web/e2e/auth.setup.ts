import { test as setup } from "@playwright/test";
import { createDb, rateLimits } from "@ssc/db";
import { loadRootEnv } from "@ssc/env";
import { signIn } from "./helpers";

/*
 * Signs each demo role in ONCE through the real passwordless flow and saves the session, so the
 * suites can reuse it without exceeding the (intentionally strict) sign-in rate limits.
 */
const DEMO = "demo.san-sebastian.invalid";

for (const role of ["customer", "staff", "manager", "owner"] as const) {
  setup(`sign in as demo ${role}`, async ({ page }) => {
    await signIn(page, `${role}@${DEMO}`, "fr");
    await page.context().storageState({ path: `e2e/.auth/${role}.json` });
  });
}

// The sign-ins above are setup, not part of any spec: give the specs the full sign-in budget.
setup("reset sign-in rate limits", async () => {
  loadRootEnv();
  const { db, close } = createDb(process.env.DATABASE_URL_E2E ?? "", { max: 1 });
  try {
    await db.delete(rateLimits);
  } finally {
    await close();
  }
});
