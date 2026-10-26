import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { requirePermissionForPage } from "@/server/session";
import { GiftCardDesk } from "./GiftCardDesk.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff/gift-cards">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "StaffGiftCards" });
  return { title: t("title"), robots: { index: false } };
}

/** Gift cards at the counter: sell (shift lead+), look up, take a purchase off, block, correct. */
export default async function StaffGiftCardsPage({
  params,
}: PageProps<"/[locale]/staff/gift-cards">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/staff/gift-cards`,
    "gift_cards:redeem",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const t = await getTranslations("StaffGiftCards");
  return (
    <Container className="max-w-3xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <Link href="/staff" className={`${buttonClasses("secondary")} mb-6`}>
        {t("backToQueue")}
      </Link>
      <GiftCardDesk
        canIssue={can(access.user.role, "gift_cards:issue")}
        canAdjust={can(access.user.role, "gift_cards:adjust")}
      />
    </Container>
  );
}
