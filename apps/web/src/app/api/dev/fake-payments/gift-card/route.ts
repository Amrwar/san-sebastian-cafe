import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { notFound } from "@/server/errors";
import { apiRoute, parseJson } from "@/server/http";
import { simulatePurchasePayment } from "@/server/modules/gift-cards/purchases";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const input = z.object({ purchaseId: z.uuid() });

/**
 * DEVELOPMENT PAYMENT SIMULATOR for gift card purchases — no money moves. Exists only when
 * PAYMENT_PROVIDER=fake; the approval goes through the same code as a verified Stripe payment.
 */
export const POST = apiRoute(async (req) => {
  if (env().PAYMENT_PROVIDER !== "fake") throw notFound("Route");
  const { purchaseId } = await parseJson(req, input);
  const view = await simulatePurchasePayment(
    db(),
    await getSessionUser(),
    purchaseId,
    orderTokenFrom(req),
  );
  return NextResponse.json(view);
});
