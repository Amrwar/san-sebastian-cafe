import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { syncPurchase } from "@/server/modules/gift-cards/purchases";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/gift-cards/purchases/:id/status — "is it paid yet?" Asks the payment provider
 * directly and applies the answer (issuing the card once). Guests send their purchase token.
 */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const view = await syncPurchase(db(), await getSessionUser(), params.id, orderTokenFrom(req));
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
});
