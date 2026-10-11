import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderStatus } from "@/server/modules/ordering/customer-orders";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/orders/:id/status — lightweight status for live tracking (owner, staff or token). */
export const GET = apiRoute<{ id: string }>(async (req, { params }) => {
  const status = await getOrderStatus(db(), await getSessionUser(), params.id, orderTokenFrom(req));
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
});
