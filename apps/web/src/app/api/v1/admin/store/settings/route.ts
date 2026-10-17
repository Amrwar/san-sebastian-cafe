import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { saveStoreSettings } from "@/server/modules/admin/store";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/store/settings — online ordering settings (manager and above). */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  await saveStoreSettings(db(), await getSessionUser(), body);
  return new NextResponse(null, { status: 204 });
});
