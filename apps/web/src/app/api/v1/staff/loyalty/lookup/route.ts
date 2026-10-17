import { NextResponse } from "next/server";
import { can } from "@ssc/domain";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { lookupCardCode } from "@/server/modules/loyalty/in-store";
import { findLoyaltyCustomer } from "@/server/modules/loyalty/staff";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/staff/loyalty/lookup — { query } (exact email or card code). Returns the customer
 * (minimum PII) and, for a valid code when in-store stamps are on, their card for the counter.
 */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  const query =
    typeof body === "object" && body !== null && "query" in body && typeof body.query === "string"
      ? body.query.slice(0, 320)
      : "";
  const user = await getSessionUser();
  const match = await findLoyaltyCustomer(db(), user, query);
  const counter =
    match && !query.includes("@") && can(user?.role, "loyalty:in_store")
      ? await lookupCardCode(db(), user, query).catch(() => null)
      : null;
  return NextResponse.json({ match, counter });
});
