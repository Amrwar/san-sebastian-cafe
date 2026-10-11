import { NextResponse } from "next/server";
import { sql } from "@ssc/db";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";

export const dynamic = "force-dynamic";

/** Liveness + database readiness. Returns 503 when the database is unreachable. */
export const GET = apiRoute(async (_req, { log }) => {
  try {
    await db().execute(sql`select 1`);
    return NextResponse.json(
      { status: "ok", database: "ok" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    log.error({ err }, "health check: database unreachable");
    return NextResponse.json(
      { status: "degraded", database: "unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
});
