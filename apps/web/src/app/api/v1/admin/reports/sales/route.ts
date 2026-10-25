import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getSalesReport } from "@/server/modules/reports/sales";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/admin/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD[&demo=1] (café dates, inclusive). */
export const GET = apiRoute(async (req) => {
  const q = req.nextUrl.searchParams;
  const report = await getSalesReport(db(), await getSessionUser(), {
    from: q.get("from"),
    to: q.get("to"),
    includeDemo: q.get("demo") ?? undefined,
  });
  return NextResponse.json(report);
});
