import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Badge, Container, PageHeader, Surface } from "@ssc/ui";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/gift-cards">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "GiftCards" });
  return { title: t("title") };
}

/**
 * Gift cards are not implemented: they depend on the café's POS (decision D1/D17). This page says
 * so plainly and offers no purchase or balance form that could look functional.
 */
export default async function GiftCardsPage() {
  const [t, tCommon] = await Promise.all([getTranslations("GiftCards"), getTranslations("Common")]);
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <div className="flex flex-col gap-6">
        <Alert tone="warning" title={t("unavailableTitle")} role="note">
          {t("unavailableBody")}
        </Alert>
        <Surface className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-espresso">{t("policyTitle")}</h2>
            <Badge>{tCommon("notAvailableYet")}</Badge>
          </div>
          <p className="text-espresso-muted">{t("policyBody")}</p>
        </Surface>
      </div>
    </Container>
  );
}
