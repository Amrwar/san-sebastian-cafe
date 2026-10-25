import { getTranslations } from "next-intl/server";
import { Container } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

export async function SiteFooter() {
  const t = await getTranslations("Footer");
  return (
    <footer className="border-t border-line bg-ivory-sunken pb-20 md:pb-0 print:hidden">
      <Container className="flex flex-col gap-4 py-8 text-sm text-espresso-muted md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <p>
            <span className="font-display text-base text-espresso">San Sebastian Café</span> ·{" "}
            {t("city")}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            <li>
              <Link href="/promotions" className="underline underline-offset-4 hover:text-espresso">
                {t("promotions")}
              </Link>
            </li>
            <li>
              <Link href="/gift-cards" className="underline underline-offset-4 hover:text-espresso">
                {t("giftCards")}
              </Link>
            </li>
            <li>
              <Link href="/privacy" className="underline underline-offset-4 hover:text-espresso">
                {t("privacy")}
              </Link>
            </li>
            <li>
              <Link href="/terms" className="underline underline-offset-4 hover:text-espresso">
                {t("terms")}
              </Link>
            </li>
            <li>
              <Link
                href="/sign-in/help"
                className="underline underline-offset-4 hover:text-espresso"
              >
                {t("help")}
              </Link>
            </li>
          </ul>
        </div>
        <p className="max-w-md">{t("devNotice")}</p>
      </Container>
    </footer>
  );
}
