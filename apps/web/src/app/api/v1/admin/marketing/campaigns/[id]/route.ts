import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveCampaign } from "@/server/modules/marketing/campaigns";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/marketing/campaigns/:id — edits a draft. */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveCampaign(db(), await getSessionUser(), body, params.id));
});
