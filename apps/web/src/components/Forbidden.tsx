import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

/** Shown to signed-in users who lack permission for a section (the HTTP API returns 403). */
export async function Forbidden() {
  const t = await getTranslations("Errors");
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow="403" title={t("forbiddenTitle")}>
        <p>{t("forbiddenBody")}</p>
      </PageHeader>
      <Link href="/" className={buttonClasses("secondary")}>
        {t("backHome")}
      </Link>
    </Container>
  );
}
