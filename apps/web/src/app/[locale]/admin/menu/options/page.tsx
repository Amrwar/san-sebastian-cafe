import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listModifierGroups } from "@/server/modules/admin/menu";
import { requirePermissionForPage } from "@/server/session";
import { OptionGroups } from "./OptionGroups.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/menu/options">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminOptions" });
  return { title: t("title"), robots: { index: false } };
}

/** Reusable option groups (milk, syrups, temperature…), manager and above. */
export default async function AdminOptionsPage({
  params,
}: PageProps<"/[locale]/admin/menu/options">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/menu/options`,
    "catalog:manage",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const [t, groups] = await Promise.all([
    getTranslations("AdminOptions"),
    listModifierGroups(db(), access.user),
  ]);

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="options" role={access.user.role} />
      <OptionGroups groups={groups} />
    </Container>
  );
}
