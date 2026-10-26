import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { checkGiftCardBalance } from "@/server/modules/gift-cards/gift-cards";
import { enforceLimit, requester } from "@/server/rate-limit";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/gift-cards/balance — { code } → balance and status (404 for an unknown code). The
 * code travels in the body, never in the URL. Rate-limited so codes can't be guessed.
 */
export const POST = apiRoute(async (req) => {
  const user = await getSessionUser();
  await enforceLimit(db(), "giftCardLookup", requester(req, user?.userId));
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await checkGiftCardBalance(db(), body), {
    headers: { "cache-control": "no-store" },
  });
});
