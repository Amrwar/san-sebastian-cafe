import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { enforceLimit, requester } from "@/server/rate-limit";
import { apiRoute } from "@/server/http";
import { enterReferralCode } from "@/server/modules/loyalty/referrals";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/me/referral — a new customer enters the code of the customer who referred them. */
export const POST = apiRoute(async (req) => {
  const user = await getSessionUser();
  await enforceLimit(db(), "referralCode", requester(req, user?.userId));
  const body: unknown = await req.json().catch(() => null);
  await enterReferralCode(db(), user, body);
  return new NextResponse(null, { status: 204 });
});
