import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { enforceLimit, requester } from "@/server/rate-limit";
import { apiRoute, parseJson } from "@/server/http";
import { cartQuoteInput, quoteCart } from "@/server/modules/ordering/cart-quote";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/cart/quote — server-authoritative prices, taxes, promotion, reward and tip for a
 * cart described by ids and quantities only. Read-only: nothing is reserved or charged.
 */
export const POST = apiRoute(async (req) => {
  const user = await getSessionUser();
  await enforceLimit(db(), "cartQuote", requester(req, user?.userId));
  const input = await parseJson(req, cartQuoteInput);
  const result = await quoteCart(db(), user, input);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
});
