import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { sendCampaignTest } from "@/server/modules/marketing/campaigns";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/marketing/campaigns/:id/test — a preview to my own address (`{ locale }`). */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body = (await req.json().catch(() => ({}))) as { locale?: unknown };
  await sendCampaignTest(
    db(),
    await getSessionUser(),
    params.id,
    body.locale === "en" ? "en" : "fr",
  );
  return new NextResponse(null, { status: 202 });
});
