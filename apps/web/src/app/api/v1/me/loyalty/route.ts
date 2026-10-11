import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getLoyaltySummary } from "@/server/modules/loyalty/summary";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/loyalty — stamp card, rewards wallet and ledger history. */
export const GET = apiRoute(async () => {
  return NextResponse.json(await getLoyaltySummary(db(), await getSessionUser()));
});
