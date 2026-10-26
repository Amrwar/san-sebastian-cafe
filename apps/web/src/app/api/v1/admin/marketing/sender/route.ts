import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveSender } from "@/server/modules/marketing/campaigns";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/marketing/sender — business name and mailing address shown in every email. */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  await saveSender(db(), await getSessionUser(), body);
  return new NextResponse(null, { status: 204 });
});
