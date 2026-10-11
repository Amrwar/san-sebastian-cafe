import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getStaffQueue } from "@/server/modules/ordering/staff-queue";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/staff/orders — live kitchen queue (staff only). Polled by the staff screen. */
export const GET = apiRoute(async () => {
  return NextResponse.json(await getStaffQueue(db(), await getSessionUser()), {
    headers: { "cache-control": "no-store" },
  });
});
