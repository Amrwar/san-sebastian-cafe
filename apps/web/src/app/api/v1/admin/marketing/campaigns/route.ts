import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveCampaign } from "@/server/modules/marketing/campaigns";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/marketing/campaigns — a new draft. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveCampaign(db(), await getSessionUser(), body), { status: 201 });
});
