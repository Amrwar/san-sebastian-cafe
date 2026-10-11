import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getPublishedMenu } from "@/server/modules/catalog/menu";

export const dynamic = "force-dynamic";

/** GET /api/v1/menu — public read-only catalog (both languages; clients choose the display locale). */
export const GET = apiRoute(async () => {
  const categories = await getPublishedMenu(db());
  return NextResponse.json({ currency: "CAD", categories });
});
