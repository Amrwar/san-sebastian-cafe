import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { savePrivacyOfficer } from "@/server/modules/privacy/officer";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/admin/privacy/officer — the privacy officer's name and contact (published). */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  await savePrivacyOfficer(db(), await getSessionUser(), body);
  return new NextResponse(null, { status: 204 });
});
