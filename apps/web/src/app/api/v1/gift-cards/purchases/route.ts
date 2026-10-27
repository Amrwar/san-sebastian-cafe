import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { apiRoute } from "@/server/http";
import { startPurchase } from "@/server/modules/gift-cards/purchases";
import { enforceLimit, requester } from "@/server/rate-limit";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/gift-cards/purchases — buy a gift card: { amountCents, recipientName,
 * recipientEmail, message?, purchaserName, purchaserEmail? (guests), locale } → the payment page
 * URL and the token that lets a guest follow the purchase. Rate-limited (card-testing fraud).
 */
export const POST = apiRoute(async (req) => {
  const user = await getSessionUser();
  await enforceLimit(db(), "giftCardPurchase", requester(req, user?.userId));
  const body: unknown = await req.json().catch(() => null);
  const started = await startPurchase(db(), user, body, { provider: env().PAYMENT_PROVIDER });
  return NextResponse.json(started, { status: 201, headers: { "cache-control": "no-store" } });
});
