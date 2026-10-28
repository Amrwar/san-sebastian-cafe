import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveDeliveryZone } from "@/server/modules/admin/delivery";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/delivery-zones — creates a delivery zone (manager and above). */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveDeliveryZone(db(), await getSessionUser(), body), {
    status: 201,
  });
});
