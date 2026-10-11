import { defineConfig, devices } from "@playwright/test";
import { loadRootEnv } from "@ssc/env";

loadRootEnv();

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const E2E_DATABASE_URL = process.env.DATABASE_URL_E2E ?? "";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    // Signs the demo roles in once; the other projects reuse the saved sessions.
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "desktop", dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
    {
      // Critical customer journeys and layout also run on a phone viewport.
      name: "mobile",
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"] },
      testMatch: /(responsive|journeys)\.spec\.ts/,
    },
  ],
  webServer: {
    // CI builds once in a separate step; locally the E2E run builds a fresh production bundle.
    command: process.env.CI
      ? `npx next start -p ${PORT}`
      : `npx next build && npx next start -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: E2E_DATABASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      EMAIL_TRANSPORT: "console",
    },
  },
});
