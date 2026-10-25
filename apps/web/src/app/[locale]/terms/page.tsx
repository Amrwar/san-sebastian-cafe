import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader } from "@ssc/ui";
import { LegalText } from "@/components/LegalText";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/terms">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Terms" });
  return { title: t("title") };
}

const SECTIONS = [
  "about",
  "ordering",
  "prices",
  "payment",
  "pickup",
  "cancellation",
  "loyalty",
  "account",
  "liability",
  "law",
  "changes",
] as const;

/** Terms of use and sale. DRAFT: the café's lawyer must review it; French first (Charter). */
export default async function TermsPage() {
  const t = await getTranslations("Terms");
  return (
    <Container className="max-w-3xl pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("updated")}</p>
      </PageHeader>
      <Alert tone="warning" className="mb-6">
        {t("draft")}
      </Alert>
      <div className="flex flex-col gap-8 text-espresso [&_p]:leading-relaxed">
        {SECTIONS.map((key) => (
          <section key={key} className="flex flex-col gap-3" aria-labelledby={`terms-${key}`}>
            <h2 id={`terms-${key}`} className="font-display text-2xl">
              {t(`sections.${key}.title`)}
            </h2>
            <LegalText text={t(`sections.${key}.body`)} />
          </section>
        ))}
      </div>
    </Container>
  );
}
