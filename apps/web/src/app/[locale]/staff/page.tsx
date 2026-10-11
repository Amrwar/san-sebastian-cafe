import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Container } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { getStaffQueue } from "@/server/modules/ordering/staff-queue";
import { requirePermissionForPage } from "@/server/session";
import { QueueBoard } from "./QueueBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "StaffQueue" });
  return { title: t("title"), robots: { index: false } };
}

/** Live order queue for staff (tablet behind the counter). */
export default async function StaffPage({ params }: PageProps<"/[locale]/staff">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(locale, `/${locale}/staff`, "staff_console:access");
  if (access.status === "forbidden") return <Forbidden />;
  const [t, queue] = await Promise.all([
    getTranslations("StaffQueue"),
    getStaffQueue(db(), access.user),
  ]);

  return (
    <Container className="max-w-[90rem] py-6">
      <h1 className="mb-4 font-display text-4xl text-espresso">{t("title")}</h1>
      <QueueBoard
        initial={queue}
        canPause={can(access.user.role, "store:pause_ordering")}
        canRefund={can(access.user.role, "orders:refund")}
      />
    </Container>
  );
}
