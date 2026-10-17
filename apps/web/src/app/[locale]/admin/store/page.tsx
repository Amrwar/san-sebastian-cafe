import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { getStoreAdmin, localDate } from "@/server/modules/admin/store";
import { requirePermissionForPage } from "@/server/session";
import { ClosuresForm, HoursForm, SettingsForm } from "./StoreForms.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/store">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminStore" });
  return { title: t("title"), robots: { index: false } };
}

/** Ordering settings, opening hours and closures (manager and above). */
export default async function AdminStorePage({ params }: PageProps<"/[locale]/admin/store">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/store`,
    "store:configure",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const now = new Date();
  const [t, store] = await Promise.all([
    getTranslations("AdminStore"),
    getStoreAdmin(db(), access.user, now),
  ]);

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="store" role={access.user.role} />
      {store.usesDemoValues ? (
        <Alert tone="warning" className="mb-6" role="note">
          {t("demoWarning")}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-6">
        <SettingsForm settings={store.settings} />
        <HoursForm hours={store.hours} />
        <ClosuresForm closures={store.closures} today={localDate(now)} />
      </div>
    </Container>
  );
}
