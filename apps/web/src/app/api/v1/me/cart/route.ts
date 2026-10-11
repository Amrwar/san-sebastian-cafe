import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getSavedCart, saveCart } from "@/server/modules/customer/cart";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/cart — the signed-in customer's saved cart (ids and quantities only). */
export const GET = apiRoute(async () => {
  return NextResponse.json(await getSavedCart(db(), await getSessionUser()), {
    headers: { "cache-control": "no-store" },
  });
});

/** PUT /api/v1/me/cart — replace the saved cart (`expectedVersion` → 409 if changed elsewhere). */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveCart(db(), await getSessionUser(), body));
});
