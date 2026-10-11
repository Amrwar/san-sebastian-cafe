import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { notFound } from "@/server/errors";
import { apiRoute, parseJson } from "@/server/http";
import { resolveOrderAccess } from "@/server/modules/ordering/order-access";
import { recordPaymentOutcome } from "@/server/modules/payments/confirm";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

const input = z.object({ orderId: z.uuid(), outcome: z.enum(["approve", "decline"]) });

/**
 * DEVELOPMENT PAYMENT SIMULATOR — no money moves. Exists only when PAYMENT_PROVIDER=fake (which
 * environment validation refuses in staging/production). It goes through the same
 * `recordPaymentOutcome` path a real provider webhook will use; approving twice is idempotent.
 */
export const POST = apiRoute(async (req) => {
  if (env().PAYMENT_PROVIDER !== "fake") throw notFound("Route");
  const { orderId, outcome } = await parseJson(req, input);
  const { order } = await resolveOrderAccess(
    db(),
    await getSessionUser(),
    orderId,
    orderTokenFrom(req),
  );
  const result = await recordPaymentOutcome(db(), {
    provider: "fake",
    // Approvals share one event id per order (repeat clicks are duplicates); declines are distinct.
    eventId: outcome === "approve" ? `fake_evt_${order.id}` : `fake_evt_decline_${randomUUID()}`,
    orderId: order.id,
    providerPaymentId: `fake_pay_${order.id}`,
    amountCents: order.totalCents,
    outcome: outcome === "approve" ? "succeeded" : "failed",
    cardBrand: "test",
    cardLast4: "0000",
  });
  return NextResponse.json(result);
});
