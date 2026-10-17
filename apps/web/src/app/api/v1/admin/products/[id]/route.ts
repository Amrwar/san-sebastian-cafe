import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { archiveProduct, saveProduct } from "@/server/modules/admin/menu";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/products/:id — replace a product (sizes left out are archived). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveProduct(db(), await getSessionUser(), body, params.id));
});

/** DELETE /api/v1/admin/products/:id — archive (past orders keep their snapshots). */
export const DELETE = apiRoute<{ id: string }>(async (_req, { params }) => {
  await archiveProduct(db(), await getSessionUser(), params.id);
  return new NextResponse(null, { status: 204 });
});
