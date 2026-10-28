import { NextResponse } from "next/server";
import { assertCronRequest } from "@/server/cron";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { withJobRun } from "@/server/monitoring/jobs";
import { runRetention } from "@/server/modules/privacy/retention";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/retention — daily retention job: expired sessions and codes, old guest contact
 * details, old payment webhook payloads. Requires `Authorization: Bearer $CRON_SECRET`.
 */
export const GET = apiRoute(async (req, { log }) => {
  assertCronRequest(req);
  const summary = await withJobRun(db(), "retention", () => runRetention(db()));
  log.info(summary, "retention run");
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});
