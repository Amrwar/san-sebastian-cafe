import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listAdminMenu } from "@/server/modules/admin/menu";
import { listProgramVersions } from "@/server/modules/loyalty/program";
import { requirePermissionForPage } from "@/server/session";
import { RulesForm } from "./RulesForm.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/loyalty">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminLoyalty" });
  return { title: t("title"), robots: { index: false } };
}

/** Loyalty program versions: the owner edits, managers read. */
export default async function AdminLoyaltyPage({ params }: PageProps<"/[locale]/admin/loyalty">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/loyalty`,
    "admin_console:access",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const canEdit = can(user.role, "loyalty:configure");

  const [t, format, versions, menu] = await Promise.all([
    getTranslations("AdminLoyalty"),
    getFormatter(),
    listProgramVersions(db(), user),
    can(user.role, "catalog:manage") ? listAdminMenu(db(), user) : Promise.resolve([]),
  ]);
  const current = versions[0];
  const drinks = menu.flatMap((c) =>
    c.products
      .filter((p) => p.isDrink)
      .map((p) => ({ id: p.id, nameFr: p.nameFr, nameEn: p.nameEn })),
  );

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="loyalty" role={user.role} />
      <div className="flex flex-col gap-6">
        {!canEdit ? (
          <Alert tone="neutral" role="note">
            {t("readOnly")}
          </Alert>
        ) : null}
        {current ? (
          <>
            <p className="font-semibold text-espresso">
              {t("current", { version: current.version })}
            </p>
            <RulesForm key={current.version} rules={current} drinks={drinks} canEdit={canEdit} />
          </>
        ) : null}
        <Surface className="flex flex-col gap-3">
          <h2 className="font-display text-2xl text-espresso">{t("history")}</h2>
          <ol className="divide-y divide-line">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-col py-2">
                <span className="font-medium text-espresso">
                  {t("versionLine", {
                    version: v.version,
                    date: format.dateTime(v.createdAt, { dateStyle: "medium", timeStyle: "short" }),
                  })}
                </span>
                {v.note ? <span className="text-sm text-espresso-muted">{v.note}</span> : null}
              </li>
            ))}
          </ol>
        </Surface>
      </div>
    </Container>
  );
}
