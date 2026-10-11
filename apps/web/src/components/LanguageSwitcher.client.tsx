"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

/** Links to the same page in the other language. Rendered as a link (not a toggle) so it works without JS. */
export function LanguageSwitcher() {
  const t = useTranslations("Common");
  const locale = useLocale();
  const pathname = usePathname();
  const target = locale === "fr" ? "en" : "fr";

  return (
    <Link
      href={pathname}
      locale={target}
      hrefLang={target === "fr" ? "fr-CA" : "en-CA"}
      lang={target === "fr" ? "fr-CA" : "en-CA"}
      aria-label={t("switchLanguageLabel")}
      className="inline-flex min-h-11 items-center rounded-pill border border-ivory/30 px-3.5 text-sm font-medium text-ivory transition-colors hover:border-crema hover:text-crema"
    >
      {t("switchLanguage")}
    </Link>
  );
}
