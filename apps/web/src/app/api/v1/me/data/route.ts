import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { enforceLimit, requester } from "@/server/rate-limit";
import { apiRoute } from "@/server/http";
import { deleteOwnAccount } from "@/server/modules/privacy/deletion";
import { exportPersonalData } from "@/server/modules/privacy/export";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/data — a copy of all the signed-in customer's personal data (JSON download). */
export const GET = apiRoute(async (req) => {
  const now = new Date();
  const user = await getSessionUser();
  if (user) await enforceLimit(db(), "dataExport", requester(req, user.userId));
  const data = await exportPersonalData(db(), user, now);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="san-sebastian-cafe-donnees-${now.toISOString().slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    },
  });
});

/**
 * DELETE /api/v1/me/data — deletes the signed-in customer's account (body: `{ confirmEmail }`).
 * Orders are kept for tax purposes, anonymized.
 */
export const DELETE = apiRoute(async (req) => {
  const user = await getSessionUser();
  if (user) await enforceLimit(db(), "accountDeletion", requester(req, user.userId));
  const body: unknown = await req.json().catch(() => null);
  const result = await deleteOwnAccount(db(), user, body);
  return NextResponse.json(result);
});
