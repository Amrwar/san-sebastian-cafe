import { NextResponse } from "next/server";
import { assertMonitoringRequest } from "@/server/cron";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { apiRoute } from "@/server/http";
import { listJobRuns } from "@/server/monitoring/jobs";
import { collectSignals, overallStatus } from "@/server/monitoring/signals";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/details — every operational signal and the last run of each scheduled job,
 * for an uptime monitor (`Authorization: Bearer $MONITORING_TOKEN`; 404 when it isn't set).
 * 503 when a signal fails, so the monitor's own alerting works without parsing the body.
 */
export const GET = apiRoute(async (req) => {
  assertMonitoringRequest(req);
  const [signals, jobs] = await Promise.all([
    collectSignals(db(), { jobsScheduled: Boolean(env().CRON_SECRET) }),
    listJobRuns(db()),
  ]);
  const status = overallStatus(signals);
  return NextResponse.json(
    { status, signals, jobs },
    { status: status === "fail" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
});
