import { defineRouting } from "next-intl/routing";
import type { Locale } from "@ssc/domain";

/**
 * URL locales. French is the default (Charter of the French Language). Browser-language detection
 * is disabled so first-time visitors always land in French; English is one click away.
 * (Owner/legal decision recorded in docs/07-open-decisions.md, D20.)
 */
export const routing = defineRouting({
  locales: ["fr", "en"],
  defaultLocale: "fr",
  localePrefix: "always",
  localeDetection: false,
});

export type UrlLocale = (typeof routing.locales)[number];

export const TIME_ZONE = "America/Toronto"; // Montréal

/** Maps a URL locale to the BCP 47 locale used for formatting and stored preferences. */
export function toDomainLocale(locale: string): Locale {
  return locale === "en" ? "en-CA" : "fr-CA";
}

export function toUrlLocale(locale: Locale): UrlLocale {
  return locale === "en-CA" ? "en" : "fr";
}
