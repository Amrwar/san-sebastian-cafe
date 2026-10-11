import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError, notFound } from "@/server/errors";
import { apiRoute } from "@/server/http";
import { WebhookSignatureError } from "@/server/modules/payments/provider";
import { handlePaymentWebhook } from "@/server/modules/payments/webhooks";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe — Stripe event notifications. The raw body is verified against the
 * endpoint's signing secret before anything is read; invalid or stale signatures get 400 and
 * nothing is stored. Processing errors return 500 so Stripe retries (each event is applied once).
 */
export const POST = apiRoute(async (req, { log }) => {
  if (!env().STRIPE_WEBHOOK_SECRET) throw notFound("Route");
  const rawBody = await req.text();
  try {
    const result = await handlePaymentWebhook(
      db(),
      "stripe",
      rawBody,
      req.headers.get("stripe-signature"),
    );
    log.info(result, "stripe webhook processed");
    return NextResponse.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof WebhookSignatureError)
      throw new AppError("validation_failed", error.message, [], "invalid_signature");
    throw error;
  }
});
