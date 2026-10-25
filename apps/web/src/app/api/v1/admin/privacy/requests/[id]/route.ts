import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { closePrivacyRequest } from "@/server/modules/privacy/requests";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PATCH /api/v1/admin/privacy/requests/:id — closes a request (completed or refused). */
export const PATCH = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  await closePrivacyRequest(db(), await getSessionUser(), params.id, body);
  return new NextResponse(null, { status: 204 });
});
