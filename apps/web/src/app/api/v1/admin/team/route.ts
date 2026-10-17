import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { setTeamRole } from "@/server/modules/admin/team";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/admin/team — { email, role } gives a staff role (creating the account if needed)
 * or, with role "customer", removes staff access. Owner only.
 */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await setTeamRole(db(), await getSessionUser(), body));
});
