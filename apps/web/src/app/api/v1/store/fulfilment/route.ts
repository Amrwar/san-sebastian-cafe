import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getFulfilmentOptions } from "@/server/modules/store/pickup";

export const dynamic = "force-dynamic";

/** GET /api/v1/store/fulfilment — pickup times (ASAP + slots) and whether delivery is offered. */
export const GET = apiRoute(async () => {
  const options = await getFulfilmentOptions(db());
  return NextResponse.json(options, { headers: { "cache-control": "no-store" } });
});
