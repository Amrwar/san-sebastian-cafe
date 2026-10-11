import { getTranslations } from "next-intl/server";
import { Container } from "@ssc/ui";

export async function SiteFooter() {
  const t = await getTranslations("Footer");
  return (
    <footer className="border-t border-line bg-ivory-sunken">
      <Container className="flex flex-col gap-2 py-8 text-sm text-espresso-muted sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span className="font-display text-base text-espresso">San Sebastian Café</span> ·{" "}
          {t("city")}
        </p>
        <p className="max-w-md">{t("devNotice")}</p>
      </Container>
    </footer>
  );
}
