import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { buttonClasses, cn, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import {
  AUDIT_AREAS,
  AUDIT_PAGE_SIZE,
  listAuditLog,
  type AuditArea,
} from "@/server/modules/admin/overview";
import { requirePermissionForPage } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/audit">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminAudit" });
  return { title: t("title"), robots: { index: false } };
}

const isArea = (v: unknown): v is AuditArea =>
  typeof v === "string" && (AUDIT_AREAS as readonly string[]).includes(v);

/** The full audit trail, filterable by area (manager and above). */
export default async function AdminAuditPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/audit">) {
  const { locale } = await params;
  const sp = await searchParams;
  const area = isArea(sp.area) ? sp.area : null;
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const access = await requirePermissionForPage(locale, `/${locale}/admin/audit`, "audit:read");
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;

  const [t, tRoles, format, log] = await Promise.all([
    getTranslations("AdminAudit"),
    getTranslations("Roles"),
    getFormatter(),
    listAuditLog(db(), user, { area, page }),
  ]);
  const pages = Math.max(1, Math.ceil(log.total / AUDIT_PAGE_SIZE));
  const href = (next: { area?: AuditArea | null; page?: number }) => {
    const query = new URLSearchParams();
    const a = next.area === undefined ? area : next.area;
    if (a) query.set("area", a);
    if (next.page && next.page > 1) query.set("page", String(next.page));
    const qs = query.toString();
    return `/admin/audit${qs ? `?${qs}` : ""}`;
  };
  const label = (action: string) => {
    const key = `actions.${action}`;
    return t.has(key) ? t(key as "title") : action;
  };
  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-11 items-center rounded-pill border px-4 text-[0.95rem]",
      active
        ? "border-burgundy bg-burgundy text-ivory"
        : "border-line-strong bg-ivory-raised text-espresso hover:border-espresso-muted",
    );

  return (
    <Container className="max-w-5xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="audit" role={user.role} />

      <nav aria-label={t("filterLabel")} className="-mx-4 mb-6 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1">
          <li className="shrink-0">
            <Link
              href={href({ area: null })}
              aria-current={area === null ? "page" : undefined}
              className={chip(area === null)}
            >
              {t("all")}
            </Link>
          </li>
          {AUDIT_AREAS.map((a) => (
            <li key={a} className="shrink-0">
              <Link
                href={href({ area: a })}
                aria-current={area === a ? "page" : undefined}
                className={chip(area === a)}
              >
                {t(`areas.${a}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Surface>
        {log.entries.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {log.entries.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-espresso">{label(e.action)}</span>
                  <time
                    dateTime={e.createdAt.toISOString()}
                    className="text-sm text-espresso-muted"
                  >
                    {format.dateTime(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                </div>
                <span className="text-sm text-espresso-muted">
                  {t("who")}{" "}
                  {e.actorName
                    ? `${e.actorName} (${tRoles(e.actorRole ?? "customer")})`
                    : e.actorRole
                      ? t("customer")
                      : t("system")}
                  {" · "}
                  <code className="font-mono text-xs">{e.action}</code>
                </span>
                {Object.keys(e.metadata).length > 0 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-espresso underline underline-offset-4">
                      {t("details")}
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded-sm bg-ivory-sunken p-3 font-mono text-xs whitespace-pre-wrap break-words">
                      {JSON.stringify(e.metadata, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {pages > 1 ? (
        <nav
          aria-label={t("title")}
          className="mt-6 flex flex-wrap items-center justify-between gap-3"
        >
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className={buttonClasses("secondary")}>
              {t("previous")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-espresso-muted">{t("pageOf", { page, pages })}</span>
          {page < pages ? (
            <Link href={href({ page: page + 1 })} className={buttonClasses("secondary")}>
              {t("next")}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </Container>
  );
}
