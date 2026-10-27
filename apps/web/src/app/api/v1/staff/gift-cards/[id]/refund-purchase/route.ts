import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { refundPurchaseAsStaff } from "@/server/modules/gift-cards/purchases";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/gift-cards/:id/refund-purchase — { reason } refunds an unused online card. */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(
    await refundPurchaseAsStaff(db(), await getSessionUser(), params.id, body),
    {
      headers: { "cache-control": "no-store" },
    },
  );
});
