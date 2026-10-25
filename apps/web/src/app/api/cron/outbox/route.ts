import { NextResponse } from "next/server";
import { assertCronRequest } from "@/server/cron";
import { apiRoute } from "@/server/http";
import { drainOutbox } from "@/server/notifications/deliver";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/outbox — sends customer notifications still queued (retries, or a change made
 * outside an API request). Every minute is plenty: most messages go out right after the change.
 */
export const GET = apiRoute(async (req, { log }) => {
  assertCronRequest(req);
  const run = await drainOutbox();
  log.info(run ?? {}, "outbox run");
  return NextResponse.json(run ?? { error: true }, { headers: { "cache-control": "no-store" } });
});
