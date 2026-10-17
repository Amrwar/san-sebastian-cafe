import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { issueCardCode } from "@/server/modules/loyalty/card-code";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/me/loyalty/card-code — the short-lived code shown at the counter. */
export const POST = apiRoute(async () => {
  const result = await issueCardCode(db(), await getSessionUser());
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
});
