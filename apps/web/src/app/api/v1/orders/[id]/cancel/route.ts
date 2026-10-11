import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { cancelOrderAsCustomer } from "@/server/modules/ordering/manage-order";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/orders/:id/cancel — customer cancellation (until accepted; paid orders refunded). */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const result = await cancelOrderAsCustomer(
    db(),
    await getSessionUser(),
    params.id,
    orderTokenFrom(req),
  );
  return NextResponse.json(result);
});
