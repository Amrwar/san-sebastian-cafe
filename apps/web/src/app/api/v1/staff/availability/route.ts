import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getAvailabilityBoard, setItemAvailability } from "@/server/modules/ordering/staff-queue";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/staff/availability — products and options with their sale state. */
export const GET = apiRoute(async () => {
  return NextResponse.json(await getAvailabilityBoard(db(), await getSessionUser()), {
    headers: { "cache-control": "no-store" },
  });
});

/** PUT /api/v1/staff/availability — { target, id, state, minutes? } ("86" or restore an item). */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await setItemAvailability(db(), await getSessionUser(), body));
});
