import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listAdminMenu } from "@/server/modules/admin/menu";
import { requirePermissionForPage } from "@/server/session";
import { MenuBoard } from "./MenuBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/menu">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMenu" });
  return { title: t("title"), robots: { index: false } };
}

/** Categories and products in menu order (manager and above). */
export default async function AdminMenuPage({ params }: PageProps<"/[locale]/admin/menu">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(locale, `/${locale}/admin/menu`, "catalog:manage");
  if (access.status === "forbidden") return <Forbidden />;
  const [t, menu] = await Promise.all([
    getTranslations("AdminMenu"),
    listAdminMenu(db(), access.user),
  ]);

  return (
    <Container className="max-w-5xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="menu" role={access.user.role} />
      <MenuBoard menu={menu} />
    </Container>
  );
}
