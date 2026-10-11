import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/offline">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Offline" });
  return { title: t("title") };
}

/** Cached by the service worker and shown when a navigation fails offline. Shows no live data. */
export default async function OfflinePage({ params }: PageProps<"/[locale]/offline">) {
  const { locale } = await params;
  const t = await getTranslations("Offline");
  return (
    <Container className="max-w-xl">
      <PageHeader title={t("title")}>
        <p>{t("body")}</p>
      </PageHeader>
      {/* A plain link (full navigation) so the service worker retries the network. */}
      <a href={`/${locale}`} className={buttonClasses("primary")}>
        {t("retry")}
      </a>
    </Container>
  );
}
