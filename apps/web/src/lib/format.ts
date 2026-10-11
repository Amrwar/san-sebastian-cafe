import { cents, formatCad } from "@ssc/domain";
import { toDomainLocale } from "@/i18n/routing";

/** CAD amount for a URL locale ("fr" → "4,50 $", "en" → "$4.50"). */
export function money(amountCents: number, locale: string): string {
  return formatCad(cents(amountCents), toDomainLocale(locale));
}

/** Picks the French or English variant of a bilingual record field. */
export function pick(record: object, field: string, locale: string): string {
  const value = (record as Record<string, unknown>)[field + (locale === "en" ? "En" : "Fr")];
  return typeof value === "string" ? value : "";
}
