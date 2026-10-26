import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { enterReferralCode } from "@/server/modules/loyalty/referrals";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/me/referral — a new customer enters the code of the customer who referred them. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  await enterReferralCode(db(), await getSessionUser(), body);
  return new NextResponse(null, { status: 204 });
});
