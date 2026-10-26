import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getStockHistory } from "@/server/modules/inventory/stock";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/staff/stock/history?target=product|option&id= — latest stock movements of an item. */
export const GET = apiRoute(async (req) => {
  const params = req.nextUrl.searchParams;
  const history = await getStockHistory(db(), await getSessionUser(), {
    target: params.get("target"),
    id: params.get("id"),
  });
  return NextResponse.json(history, { headers: { "cache-control": "no-store" } });
});
