import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { voidInStoreVisit } from "@/server/modules/loyalty/in-store";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/loyalty/visits/:id/void — { reason } (shift lead and above). */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await voidInStoreVisit(db(), await getSessionUser(), params.id, body));
});
