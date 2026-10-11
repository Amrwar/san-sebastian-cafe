import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { syncCheckout } from "@/server/modules/payments/checkout";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/orders/:id/payment — "is it paid yet?" Asks the payment provider directly
 * (authenticated) about the order's open payment page and applies the answer, so the return page
 * doesn't depend on the webhook having arrived. The redirect itself proves nothing.
 */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const view = await syncCheckout(db(), await getSessionUser(), params.id, orderTokenFrom(req));
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
});
