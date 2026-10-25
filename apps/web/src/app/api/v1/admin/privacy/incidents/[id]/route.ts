import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveIncident } from "@/server/modules/privacy/incidents";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/privacy/incidents/:id — corrects an incident (entries are never deleted). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveIncident(db(), await getSessionUser(), body, params.id));
});
