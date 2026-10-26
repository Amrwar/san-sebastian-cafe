import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { savePromotion } from "@/server/modules/admin/promotions";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/promotions/:id — edits a promotion (switch it off with isActive: false). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await savePromotion(db(), await getSessionUser(), body, params.id));
});
