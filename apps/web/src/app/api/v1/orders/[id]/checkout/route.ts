import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { apiRoute, parseJson } from "@/server/http";
import { startCheckout } from "@/server/modules/payments/checkout";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const input = z.object({ locale: z.enum(["fr", "en"]).default("fr") });

/**
 * POST /api/v1/orders/:id/checkout — opens the provider's hosted payment page for an order
 * awaiting payment and returns its URL. Repeated calls return the same page while it is open,
 * so a customer can't be sent to pay twice. 422 `reason`: payments_unavailable, order_expired,
 * not_awaiting_payment, payment_processing.
 */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const { locale } = await parseJson(req, input);
  const started = await startCheckout(
    db(),
    await getSessionUser(),
    params.id,
    orderTokenFrom(req),
    locale,
  );
  return NextResponse.json(started, { headers: { "cache-control": "no-store" } });
});
