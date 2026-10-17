import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveModifierGroup } from "@/server/modules/admin/menu";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/modifier-groups — create an option group with its options. */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveModifierGroup(db(), await getSessionUser(), body), {
    status: 201,
  });
});
