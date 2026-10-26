import { NextResponse } from "next/server";
import { authorize } from "@/server/authz";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderDetail } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/orders/:id — one of the caller's orders (404 for others' orders). */
export const GET = apiRoute<{ id: string }>(async (_req, { params }) => {
  // The account's own orders: sign-in required (guests use /api/v1/orders/:id with their link).
  const user = await getSessionUser();
  authorize(user, "orders:read_own");
  return NextResponse.json(await getOrderDetail(db(), user, params.id));
});
