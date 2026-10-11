import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderStatus } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/orders/:id/status — lightweight status for live tracking (polled). */
export const GET = apiRoute<{ id: string }>(async (_req, { params }) => {
  const status = await getOrderStatus(db(), await getSessionUser(), params.id);
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
});
