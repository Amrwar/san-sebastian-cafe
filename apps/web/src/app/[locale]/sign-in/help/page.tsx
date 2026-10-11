import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/sign-in/help">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Recovery" });
  return { title: t("title") };
}

/** Account recovery guidance. Accounts are passwordless, so recovery = regaining the email inbox. */
export default async function RecoveryPage() {
  const t = await getTranslations("Recovery");
  const items = [
    { q: t("q1"), a: t("a1") },
    { q: t("q2"), a: t("a2") },
    { q: t("q3"), a: t("a3") },
  ];
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <details
            key={item.q}
            className="group rounded-md border border-line bg-ivory-raised px-5 py-4 open:shadow-soft"
          >
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-4 text-lg font-semibold text-espresso">
              {item.q}
              <span
                aria-hidden="true"
                className="text-burgundy transition-transform group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="mt-2 leading-relaxed text-espresso-muted">{item.a}</p>
          </details>
        ))}
      </div>
      <Link href="/sign-in" className={`${buttonClasses("secondary")} mt-8`}>
        {t("backToSignIn")}
      </Link>
    </Container>
  );
}
