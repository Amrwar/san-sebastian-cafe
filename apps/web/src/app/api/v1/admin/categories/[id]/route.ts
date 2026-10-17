import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { archiveCategory, saveCategory } from "@/server/modules/admin/menu";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/categories/:id — rename, describe, show or hide a category. */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveCategory(db(), await getSessionUser(), body, params.id));
});

/** DELETE /api/v1/admin/categories/:id — archive an empty category. */
export const DELETE = apiRoute<{ id: string }>(async (_req, { params }) => {
  await archiveCategory(db(), await getSessionUser(), params.id);
  return new NextResponse(null, { status: 204 });
});
