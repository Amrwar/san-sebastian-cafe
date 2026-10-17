import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { addClosure } from "@/server/modules/admin/store";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/store/closures — close a date; reports orders already booked that day. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await addClosure(db(), await getSessionUser(), body), { status: 201 });
});
