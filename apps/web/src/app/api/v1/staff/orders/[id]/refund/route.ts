import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { refundOrderAsStaff } from "@/server/modules/ordering/manage-order";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/staff/orders/:id/refund — { amountCents, reason } (shift lead and above). */
export const POST = apiRoute<{ id: string }>(async (req, { params }) => {
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await refundOrderAsStaff(db(), await getSessionUser(), params.id, body));
});
