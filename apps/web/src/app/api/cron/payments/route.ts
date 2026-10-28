import { NextResponse } from "next/server";
import { assertCronRequest } from "@/server/cron";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { withJobRun } from "@/server/monitoring/jobs";
import { runPaymentRecovery } from "@/server/modules/payments/recovery";
import { drainOutbox } from "@/server/notifications/deliver";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/payments — payment recovery job (Vercel Cron or any scheduler). Requires
 * `Authorization: Bearer $CRON_SECRET`; disabled (404) when CRON_SECRET isn't set.
 */
export const GET = apiRoute(async (req, { log }) => {
  assertCronRequest(req);
  const summary = await withJobRun(db(), "payments", async () => {
    const result = await runPaymentRecovery(db());
    // Recovered payments and refunds may have queued customer notifications.
    await drainOutbox();
    return result;
  });
  log.info(summary, "payment recovery run");
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});
