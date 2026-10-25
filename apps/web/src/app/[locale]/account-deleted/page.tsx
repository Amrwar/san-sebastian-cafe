import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/account-deleted">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AccountDeleted" });
  return { title: t("title"), robots: { index: false } };
}

/** Shown once an account has been deleted. */
export default async function AccountDeletedPage() {
  const t = await getTranslations("AccountDeleted");
  return (
    <Container className="max-w-2xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("body")}</p>
      </PageHeader>
      <Link href="/" className={buttonClasses("primary")}>
        {t("home")}
      </Link>
    </Container>
  );
}
