import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { updateStaffNotes } from "@/server/modules/ordering/manage-order";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** PUT /api/v1/staff/orders/:id/notes — { staffNotes } (internal; never shown to customers). */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await updateStaffNotes(db(), await getSessionUser(), params.id, body));
});
