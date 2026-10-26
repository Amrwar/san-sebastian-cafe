import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { apiRoute } from "@/server/http";
import { unsubscribe } from "@/server/modules/marketing/campaigns";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/unsubscribe?u=…&t=… — withdraws marketing consent, at once. Used by the
 * unsubscribe page and by mail apps' one-click unsubscribe (RFC 8058; they send no session).
 */
export const POST = apiRoute(async (req) => {
  const q = req.nextUrl.searchParams;
  await unsubscribe(db(), q.get("u") ?? "", q.get("t") ?? "", env().BETTER_AUTH_SECRET);
  return NextResponse.json({ unsubscribed: true }, { headers: { "cache-control": "no-store" } });
});
