import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { sendCampaign } from "@/server/modules/marketing/campaigns";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/marketing/campaigns/:id/send — sends to every consenting customer, once. */
export const POST = apiRoute<{ id: string }>(async (_req, { params }) => {
  return NextResponse.json(await sendCampaign(db(), await getSessionUser(), params.id), {
    status: 202,
  });
});
