import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { locale as rootLocale } from "next/root-params";
import { routing, TIME_ZONE } from "./routing";

export default getRequestConfig(async ({ locale: override }) => {
  // An explicit override (getTranslations({ locale })) wins; otherwise the [locale] root segment.
  const requested = override ?? (await rootLocale());
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  return { locale, messages: messages.default, timeZone: TIME_ZONE };
});
