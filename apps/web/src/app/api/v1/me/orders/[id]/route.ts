import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderDetail } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/orders/:id — one of the caller's orders (404 for others' orders). */
export const GET = apiRoute<{ id: string }>(async (_req, { params }) => {
  return NextResponse.json(await getOrderDetail(db(), await getSessionUser(), params.id));
});
