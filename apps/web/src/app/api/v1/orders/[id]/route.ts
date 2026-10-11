import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderDetail } from "@/server/modules/ordering/customer-orders";
import { updateOrderAsCustomer } from "@/server/modules/ordering/manage-order";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/orders/:id — order detail for its owner, staff, or a guest with the order token. */
export const GET = apiRoute<{ id: string }>(async (req, { params }) => {
  const detail = await getOrderDetail(db(), await getSessionUser(), params.id, orderTokenFrom(req));
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
});

/** PATCH /api/v1/orders/:id — change pickup time and/or instructions (modification policy). */
export const PATCH = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  const result = await updateOrderAsCustomer(
    db(),
    await getSessionUser(),
    params.id,
    body,
    orderTokenFrom(req),
  );
  return NextResponse.json(result);
});
