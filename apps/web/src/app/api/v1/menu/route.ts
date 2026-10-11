import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { searchMenu } from "@/server/modules/catalog/storefront";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/menu?q=&category= — public read-only catalog in both languages.
 * `q` is a bilingual, accent-insensitive search; `category` is a category slug.
 */
export const GET = apiRoute(async (req) => {
  const q = req.nextUrl.searchParams.get("q")?.slice(0, 80) ?? undefined;
  const category = req.nextUrl.searchParams.get("category")?.slice(0, 80) ?? undefined;
  const categories = await searchMenu(db(), { q, category });
  return NextResponse.json({ currency: "CAD", categories });
});
