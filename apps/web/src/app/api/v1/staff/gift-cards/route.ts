import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { issueGiftCard } from "@/server/modules/gift-cards/gift-cards";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/gift-cards — { amountCents, note? } issues a card paid at the counter. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await issueGiftCard(db(), await getSessionUser(), body), {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
});
