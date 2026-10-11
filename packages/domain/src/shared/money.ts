/**
 * Money is always an integer number of cents in CAD. Floats never represent money.
 */
export type Cents = number & { readonly __brand: "Cents" };

export const CURRENCY = "CAD" as const;

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money must be an integer number of cents, received ${value}`);
  }
  return value as Cents;
}

export function addCents(...values: Cents[]): Cents {
  return cents(values.reduce<number>((sum, v) => sum + v, 0));
}

export function multiplyCents(value: Cents, quantity: number): Cents {
  if (!Number.isSafeInteger(quantity)) throw new RangeError("Quantity must be an integer");
  return cents(value * quantity);
}

/** Rates are integers in parts per million (ppm): 5% = 50_000 ppm, QST 9.975% = 99_750 ppm.
 * (Basis points cannot represent 9.975% exactly.) */
export const PPM = 1_000_000;

/**
 * Applies a rate in ppm and rounds half-up (away from zero) to the cent, using integer math only.
 * Example: 1000 cents at 99_750 ppm (9.975%) = 99.75 → 100 cents.
 */
export function applyRatePpm(value: Cents, ratePpm: number): Cents {
  if (!Number.isSafeInteger(ratePpm) || ratePpm < 0) {
    throw new RangeError("Rate must be a non-negative integer number of ppm");
  }
  const numerator = value * ratePpm;
  if (!Number.isSafeInteger(numerator))
    throw new RangeError("Amount too large for exact rate math");
  const sign = numerator < 0 ? -1 : 1;
  return cents(sign * Math.floor((Math.abs(numerator) + PPM / 2) / PPM));
}

export type SupportedLocale = "fr-CA" | "en-CA";

export function formatCad(value: Cents, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: CURRENCY }).format(
    value / 100,
  );
}
