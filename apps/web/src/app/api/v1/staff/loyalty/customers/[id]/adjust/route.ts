import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { adjustLoyalty } from "@/server/modules/loyalty/staff";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/staff/loyalty/customers/:id/adjust — { action, stamps?, rewardId?, reason,
 * idempotencyKey } (shift lead and above).
 */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await adjustLoyalty(db(), await getSessionUser(), params.id, body));
});
