import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { getMarketingAdmin } from "@/server/modules/marketing/campaigns";
import { requirePermissionForPage } from "@/server/session";
import { MarketingBoard } from "./MarketingBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/marketing">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMarketing" });
  return { title: t("title"), robots: { index: false } };
}

/** Marketing email to consenting customers (CASL), manager and above. */
export default async function AdminMarketingPage({
  params,
}: PageProps<"/[locale]/admin/marketing">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/marketing`,
    "promotions:manage",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const [t, data] = await Promise.all([
    getTranslations("AdminMarketing"),
    getMarketingAdmin(db(), user),
  ]);

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p className="max-w-2xl text-espresso-muted">{t("intro")}</p>
      </PageHeader>
      <AdminNav current="marketing" role={user.role} />
      <MarketingBoard
        sender={data.sender}
        audienceCount={data.audienceCount}
        campaigns={data.campaigns.map((c) => ({
          ...c,
          sentAt: c.sentAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
        }))}
      />
    </Container>
  );
}
