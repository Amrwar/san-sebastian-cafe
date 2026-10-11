export const LOCALES = ["fr-CA", "en-CA"] as const;
export type Locale = (typeof LOCALES)[number];
/** French is the default and primary language (Charter of the French Language). */
export const DEFAULT_LOCALE: Locale = "fr-CA";
