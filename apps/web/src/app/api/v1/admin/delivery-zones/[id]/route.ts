import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveDeliveryZone } from "@/server/modules/admin/delivery";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/delivery-zones/:id — edits a zone (switch it off with isActive: false). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveDeliveryZone(db(), await getSessionUser(), body, params.id));
});
