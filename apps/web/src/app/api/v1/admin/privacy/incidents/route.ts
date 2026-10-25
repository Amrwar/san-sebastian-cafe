import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveIncident } from "@/server/modules/privacy/incidents";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/privacy/incidents — records a confidentiality incident. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveIncident(db(), await getSessionUser(), body), {
    status: 201,
  });
});
