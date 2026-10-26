import { NextResponse } from "next/server";
import { authorize } from "@/server/authz";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderStatus } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/orders/:id/status — lightweight status for live tracking (polled). */
export const GET = apiRoute<{ id: string }>(async (_req, { params }) => {
  const user = await getSessionUser();
  authorize(user, "orders:read_own");
  const status = await getOrderStatus(db(), user, params.id);
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
});
