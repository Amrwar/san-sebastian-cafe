import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Alert, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getCatalogOverview, listRecentAuditEvents } from "@/server/modules/admin/overview";
import { requirePermissionForPage } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Admin" });
  return { title: t("title") };
}

export default async function AdminPage({ params }: PageProps<"/[locale]/admin">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(locale, `/${locale}/admin`, "admin_console:access");
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;

  const [t, format, overview, audit] = await Promise.all([
    getTranslations("Admin"),
    getFormatter(),
    getCatalogOverview(db(), user),
    can(user.role, "audit:read") ? listRecentAuditEvents(db(), user) : Promise.resolve([]),
  ]);

  const rows = [
    { label: t("categories"), ...overview.categories },
    { label: t("products"), ...overview.products },
  ];

  return (
    <Container>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="overview" role={user.role} />

      {overview.products.demo > 0 ? (
        <Alert tone="warning" className="mb-6" role="note">
          {t("demoWarning", { count: overview.products.demo })}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <Surface>
          <h2 className="font-display text-2xl text-espresso">{t("catalogTitle")}</h2>
          <table className="mt-4 w-full text-left">
            <thead>
              <tr className="border-b border-line text-sm text-espresso-muted">
                <td />
                <th scope="col" className="py-2 text-right font-semibold">
                  {t("real")}
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  {t("demo")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-line/60 last:border-0">
                  <th scope="row" className="py-2.5 font-normal">
                    {row.label}
                  </th>
                  <td className="py-2.5 text-right tabular-nums">{row.real}</td>
                  <td className="py-2.5 text-right tabular-nums">{row.demo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>

        <Surface>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-2xl text-espresso">{t("auditTitle")}</h2>
            {can(user.role, "audit:read") ? (
              <Link href="/admin/audit" className="text-sm underline underline-offset-4">
                {t("auditAll")}
              </Link>
            ) : null}
          </div>
          {audit.length === 0 ? (
            <div className="mt-4">
              <EmptyState title={t("auditEmpty")} />
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-espresso-muted">
                    <th scope="col" className="py-2 pe-4 font-semibold">
                      {t("auditWhen")}
                    </th>
                    <th scope="col" className="py-2 pe-4 font-semibold">
                      {t("auditAction")}
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      {t("auditEntity")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((e) => (
                    <tr key={e.id} className="border-b border-line/60 last:border-0">
                      <td className="py-2 pe-4 whitespace-nowrap">
                        {format.dateTime(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                      </td>
                      <td className="py-2 pe-4 font-mono text-xs">{e.action}</td>
                      <td className="py-2 font-mono text-xs">
                        {e.entityType}
                        {e.entityId ? ` · ${e.entityId.slice(0, 8)}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>
      </div>
    </Container>
  );
}
