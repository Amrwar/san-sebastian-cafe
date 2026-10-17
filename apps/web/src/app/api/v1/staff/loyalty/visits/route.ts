import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { recordInStoreVisit } from "@/server/modules/loyalty/in-store";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/loyalty/visits — stamps for a counter purchase (staff and above). */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await recordInStoreVisit(db(), await getSessionUser(), body));
});
