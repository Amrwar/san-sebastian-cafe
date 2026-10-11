import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { listMyOrders } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/orders — the caller's order history, newest first. */
export const GET = apiRoute(async () => {
  return NextResponse.json({ orders: await listMyOrders(db(), await getSessionUser()) });
});
