import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";
import { E2E_CRON_SECRET, E2E_MONITORING_TOKEN } from "./secrets";

/*
 * Monitoring end to end: the detailed health report needs the monitoring token, the monitor job
 * needs the scheduler secret and records its own run, and the owner sees the same signals on
 * the admin overview.
 */

interface Details {
  status: "ok" | "warn" | "fail";
  signals: Array<{ signal: string; status: string; detail: string }>;
  jobs: Array<{ job: string; runs: number }>;
}

test.describe("monitoring routes", () => {
  test("the detailed health report is only for the monitoring token", async ({ request }) => {
    expect((await request.get("/api/health/details")).status()).toBe(401);
    expect(
      (
        await request.get("/api/health/details", {
          headers: { authorization: `Bearer ${E2E_CRON_SECRET}` },
        })
      ).status(),
    ).toBe(401);

    const response = await request.get("/api/health/details", {
      headers: { authorization: `Bearer ${E2E_MONITORING_TOKEN}` },
    });
    const body = (await response.json()) as Details;
    expect(response.status()).toBe(body.status === "fail" ? 503 : 200);
    expect(body.signals.find((s) => s.signal === "schema")?.status).toBe("ok");
    expect(body.signals.map((s) => s.signal)).toEqual(
      expect.arrayContaining(["notifications", "job:outbox", "job:payments", "job:retention"]),
    );
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("the monitor job runs for the scheduler and records its heartbeat", async ({ request }) => {
    expect((await request.get("/api/cron/monitor")).status()).toBe(401);
    const run = await request.get("/api/cron/monitor", {
      headers: { authorization: `Bearer ${E2E_CRON_SECRET}` },
    });
    expect(run.status()).toBe(200);
    expect(await run.json()).toMatchObject({ status: expect.any(String), alerted: 0 });

    const details = (await (
      await request.get("/api/health/details", {
        headers: { authorization: `Bearer ${E2E_MONITORING_TOKEN}` },
      })
    ).json()) as Details;
    expect(details.jobs.find((j) => j.job === "monitor")?.runs).toBeGreaterThanOrEqual(1);
  });
});

test.describe("admin overview", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("the owner sees the system status", async ({ page }) => {
    await page.goto("/en/admin");
    await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
    await expect(page.getByText("Database", { exact: true })).toBeVisible();
    await expect(page.getByText("Notification sender", { exact: true })).toBeVisible();
    // No webhook in the test server: the page says alerts only reach the logs.
    await expect(page.getByText(/Alerts aren’t set up/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
