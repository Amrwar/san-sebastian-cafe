import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveProgramVersion } from "@/server/modules/loyalty/program";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/admin/loyalty/programs — save the rules as a new version (owner only). */
export const POST = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await saveProgramVersion(db(), await getSessionUser(), body), {
    status: 201,
  });
});
