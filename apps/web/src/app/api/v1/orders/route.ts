import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { apiRoute } from "@/server/http";
import { placeOrder } from "@/server/modules/ordering/place-order";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/orders — place an order from ids (status awaiting_payment). Send a fresh
 * `idempotencyKey` per checkout attempt and resend the same body to retry safely.
 * 201 created · 200 replay · 409 key reused with a different body · 422 business rule (`reason`).
 */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  const placed = await placeOrder(db(), await getSessionUser(), body, {
    provider: env().PAYMENT_PROVIDER,
  });
  return NextResponse.json(placed, {
    status: placed.replayed ? 200 : 201,
    headers: { "cache-control": "no-store" },
  });
});
