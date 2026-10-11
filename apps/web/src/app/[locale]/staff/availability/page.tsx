import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getAvailabilityBoard } from "@/server/modules/ordering/staff-queue";
import { requirePermissionForPage } from "@/server/session";
import { AvailabilityBoard } from "./AvailabilityBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff/availability">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "StaffAvailability" });
  return { title: t("title"), robots: { index: false } };
}

export default async function StaffAvailabilityPage({
  params,
}: PageProps<"/[locale]/staff/availability">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/staff/availability`,
    "catalog:toggle_availability",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const [t, board] = await Promise.all([
    getTranslations("StaffAvailability"),
    getAvailabilityBoard(db(), access.user),
  ]);
  const serialize = <T extends { unavailableUntil: Date | null }>(rows: T[]) =>
    rows.map((r) => ({ ...r, unavailableUntil: r.unavailableUntil?.toISOString() ?? null }));

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <Link href="/staff" className={`${buttonClasses("secondary")} mb-6`}>
        {t("backToQueue")}
      </Link>
      <AvailabilityBoard products={serialize(board.products)} options={serialize(board.options)} />
    </Container>
  );
}
