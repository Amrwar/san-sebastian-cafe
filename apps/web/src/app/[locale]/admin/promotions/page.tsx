import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listAdminMenu } from "@/server/modules/admin/menu";
import { listAdminPromotions } from "@/server/modules/admin/promotions";
import { requirePermissionForPage } from "@/server/session";
import { PromotionBoard } from "./PromotionBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/promotions">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminPromotions" });
  return { title: t("title"), robots: { index: false } };
}

/** Promo codes: create, edit, switch off; with how often each was used (manager+). */
export default async function AdminPromotionsPage({
  params,
}: PageProps<"/[locale]/admin/promotions">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/promotions`,
    "promotions:manage",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const [t, promotions, menu] = await Promise.all([
    getTranslations("AdminPromotions"),
    listAdminPromotions(db(), user),
    listAdminMenu(db(), user),
  ]);

  return (
    <Container className="max-w-5xl pb-10">
      <PageHeader title={t("title")}>
        <p className="max-w-2xl text-espresso-muted">{t("intro")}</p>
      </PageHeader>
      <AdminNav current="promotions" role={user.role} />
      <PromotionBoard
        promotions={promotions}
        categories={menu.map((c) => ({ id: c.id, nameFr: c.nameFr, nameEn: c.nameEn }))}
        products={menu.flatMap((c) =>
          c.products.map((p) => ({ id: p.id, nameFr: p.nameFr, nameEn: p.nameEn })),
        )}
      />
    </Container>
  );
}
