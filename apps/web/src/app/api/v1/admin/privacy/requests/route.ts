import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { createPrivacyRequest } from "@/server/modules/privacy/requests";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/privacy/requests — logs a request received by email, phone or in person. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await createPrivacyRequest(db(), await getSessionUser(), body), {
    status: 201,
  });
});
