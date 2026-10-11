import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { setOrderingPause } from "@/server/modules/ordering/staff-queue";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/pause — { minutes } pauses online ordering (0 resumes). Shift lead+. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await setOrderingPause(db(), await getSessionUser(), body));
});
