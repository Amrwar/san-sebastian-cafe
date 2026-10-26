import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { setStock } from "@/server/modules/inventory/stock";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/staff/stock — { target, id, quantity } (units on hand; null stops tracking). */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await setStock(db(), await getSessionUser(), body));
});
