import { NextResponse } from "next/server";
import { assertCronRequest } from "@/server/cron";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { runPaymentRecovery } from "@/server/modules/payments/recovery";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/payments — payment recovery job (Vercel Cron or any scheduler). Requires
 * `Authorization: Bearer $CRON_SECRET`; disabled (404) when CRON_SECRET isn't set.
 */
export const GET = apiRoute(async (req, { log }) => {
  assertCronRequest(req);
  const summary = await runPaymentRecovery(db());
  log.info(summary, "payment recovery run");
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});
