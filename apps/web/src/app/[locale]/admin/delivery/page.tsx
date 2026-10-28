import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listDeliveryZones } from "@/server/modules/admin/delivery";
import { requirePermissionForPage } from "@/server/session";
import { DeliveryBoard } from "./DeliveryBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/delivery">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminDelivery" });
  return { title: t("title"), robots: { index: false } };
}

/** Delivery zones: postal-code prefixes, fee, minimum and travel time (manager and above). */
export default async function AdminDeliveryPage({ params }: PageProps<"/[locale]/admin/delivery">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/delivery`,
    "store:configure",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const [t, zones] = await Promise.all([
    getTranslations("AdminDelivery"),
    listDeliveryZones(db(), access.user),
  ]);
  const offered = zones.some((z) => z.isActive);

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p className="max-w-2xl text-espresso-muted">{t("intro")}</p>
      </PageHeader>
      <AdminNav current="delivery" role={access.user.role} />
      <Alert tone={offered ? "success" : "neutral"} className="mb-6" role="note">
        {offered ? t("offered") : t("notOffered")}
      </Alert>
      <DeliveryBoard zones={zones} />
    </Container>
  );
}
