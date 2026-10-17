import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { removeClosure } from "@/server/modules/admin/store";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/admin/store/closures/:date — reopen a date (YYYY-MM-DD). */
export const DELETE = apiRoute<{ date: string }>(async (_req, { params }) => {
  await removeClosure(db(), await getSessionUser(), params.date);
  return new NextResponse(null, { status: 204 });
});
