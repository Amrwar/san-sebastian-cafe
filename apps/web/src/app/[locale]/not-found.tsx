import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("Errors");
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow="404" title={t("notFoundTitle")}>
        <p>{t("notFoundBody")}</p>
      </PageHeader>
      <Link href="/" className={buttonClasses("secondary")}>
        {t("backHome")}
      </Link>
    </Container>
  );
}
