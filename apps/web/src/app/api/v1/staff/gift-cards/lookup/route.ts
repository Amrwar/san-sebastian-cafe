import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { lookupGiftCard } from "@/server/modules/gift-cards/gift-cards";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/gift-cards/lookup — { code } → the card and its history. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await lookupGiftCard(db(), await getSessionUser(), body), {
    headers: { "cache-control": "no-store" },
  });
});
