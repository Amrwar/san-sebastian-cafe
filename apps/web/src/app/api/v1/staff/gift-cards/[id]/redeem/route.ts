import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { redeemAtCounter } from "@/server/modules/gift-cards/gift-cards";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/gift-cards/:id/redeem — { amountCents, note? } pays a counter purchase with the card. */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await redeemAtCounter(db(), await getSessionUser(), params.id, body), {
    headers: { "cache-control": "no-store" },
  });
});
