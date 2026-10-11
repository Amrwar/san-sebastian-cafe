import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { notFound } from "@/server/errors";
import { apiRoute, parseJson } from "@/server/http";
import { resolveOrderAccess } from "@/server/modules/ordering/order-access";
import { paymentView, simulateFakePayment } from "@/server/modules/payments/checkout";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const input = z.object({
  orderId: z.uuid(),
  outcome: z.enum(["approve", "decline"]),
  locale: z.enum(["fr", "en"]).default("fr"),
});

/**
 * DEVELOPMENT PAYMENT SIMULATOR — no money moves. Exists only when PAYMENT_PROVIDER=fake (which
 * environment validation refuses in staging/production). An approval goes through the same
 * reconciliation code as a verified Stripe payment; approving an already-paid order changes nothing.
 */
export const POST = apiRoute(async (req) => {
  if (env().PAYMENT_PROVIDER !== "fake") throw notFound("Route");
  const { orderId, outcome, locale } = await parseJson(req, input);
  const token = orderTokenFrom(req);
  const access = await resolveOrderAccess(db(), await getSessionUser(), orderId, token);
  if (access.via === "staff") throw notFound("Order");
  if (access.order.status !== "awaiting_payment")
    return NextResponse.json(await paymentView(db(), orderId));
  const view = await simulateFakePayment(db(), orderId, outcome, {
    locale,
    guestToken: access.via === "guest_token" ? token : null,
    userId: access.order.userId,
  });
  return NextResponse.json(view);
});
