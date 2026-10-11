import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { listActivePromotions } from "@/server/modules/promotions/public";

export const dynamic = "force-dynamic";

/** GET /api/v1/promotions — promotions available right now. */
export const GET = apiRoute(async () => {
  return NextResponse.json({ promotions: await listActivePromotions(db()) });
});
