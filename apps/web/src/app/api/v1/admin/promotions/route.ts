import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { savePromotion } from "@/server/modules/admin/promotions";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/promotions — creates a promotion (manager and above). */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await savePromotion(db(), await getSessionUser(), body), {
    status: 201,
  });
});
