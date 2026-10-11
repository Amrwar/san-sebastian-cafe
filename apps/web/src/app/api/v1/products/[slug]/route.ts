import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { apiRoute } from "@/server/http";
import { getProductBySlug } from "@/server/modules/catalog/storefront";

export const dynamic = "force-dynamic";

/** GET /api/v1/products/:slug — full customization configuration of one product. */
export const GET = apiRoute<{ slug: string }>(async (_req, { params }) => {
  const product = await getProductBySlug(db(), params.slug.slice(0, 120));
  if (!product) throw notFound("Product");
  return NextResponse.json(product);
});
