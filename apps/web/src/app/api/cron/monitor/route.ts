import { NextResponse } from "next/server";
import { assertCronRequest } from "@/server/cron";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { apiRoute } from "@/server/http";
import { withJobRun } from "@/server/monitoring/jobs";
import { collectSignals, runMonitor } from "@/server/monitoring/signals";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/monitor — checks the operational signals (database schema, notifications, the
 * other scheduled jobs) and alerts once when one goes bad and once when it recovers. Every 5–10
 * minutes. Requires `Authorization: Bearer $CRON_SECRET`.
 */
export const GET = apiRoute(async (req, { log }) => {
  assertCronRequest(req);
  const run = await withJobRun(db(), "monitor", async () => {
    const signals = await collectSignals(db(), { jobsScheduled: Boolean(env().CRON_SECRET) });
    return runMonitor(db(), signals);
  });
  log.info(run, "monitor run");
  return NextResponse.json(run, { headers: { "cache-control": "no-store" } });
});
