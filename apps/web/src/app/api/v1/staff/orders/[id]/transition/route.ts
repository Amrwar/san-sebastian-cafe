import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { transitionOrderAsStaff } from "@/server/modules/ordering/manage-order";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/orders/:id/transition — { to, reason?, expectedVersion } (409 if stale). */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(
    await transitionOrderAsStaff(db(), await getSessionUser(), params.id, body),
  );
});
