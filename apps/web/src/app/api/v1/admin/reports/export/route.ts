import { db } from "@/server/db";
import { enforceLimit, requester } from "@/server/rate-limit";
import { apiRoute } from "@/server/http";
import { exportReportCsv } from "@/server/modules/reports/export";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/reports/export?kind=days|orders|refunds|products&from=…&to=…&locale=fr|en
 * (&demo=1 to include demo orders).
 */
export const GET = apiRoute(async (req) => {
  const q = req.nextUrl.searchParams;
  const user = await getSessionUser();
  if (user) await enforceLimit(db(), "reportExport", requester(req, user.userId));
  const { fileName, csv } = await exportReportCsv(db(), user, {
    kind: q.get("kind"),
    from: q.get("from"),
    to: q.get("to"),
    locale: q.get("locale") ?? undefined,
    includeDemo: q.get("demo") ?? undefined,
  });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "private, no-store",
    },
  });
});
