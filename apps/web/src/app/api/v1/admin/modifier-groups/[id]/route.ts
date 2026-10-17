import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { archiveModifierGroup, saveModifierGroup } from "@/server/modules/admin/menu";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/modifier-groups/:id — replace a group (options left out are archived). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveModifierGroup(db(), await getSessionUser(), body, params.id));
});

/** DELETE /api/v1/admin/modifier-groups/:id — archive a group no current product uses. */
export const DELETE = apiRoute<{ id: string }>(async (_req, { params }) => {
  await archiveModifierGroup(db(), await getSessionUser(), params.id);
  return new NextResponse(null, { status: 204 });
});
