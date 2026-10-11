import type { TaxCategory } from "../catalog/catalog";
import { applyRatePpm, cents, type Cents } from "../shared/money";

/**
 * Québec sales taxes. Rates are effective-dated so a future change does not alter past quotes.
 * ⚖ To be confirmed by the café's accountant: product tax categories, rounding method
 * (invoice-level, half-up, each tax separately is implemented), small-supplier status.
 */
export interface TaxRate {
  code: "GST" | "QST";
  ratePpm: number;
  effectiveFrom: string; // ISO date
}

export const QUEBEC_TAX_RATES: readonly TaxRate[] = [
  { code: "GST", ratePpm: 50_000, effectiveFrom: "2008-01-01" },
  { code: "QST", ratePpm: 99_750, effectiveFrom: "2013-01-01" },
];

export function rateOn(code: TaxRate["code"], at: Date, rates = QUEBEC_TAX_RATES): number {
  const day = at.toISOString().slice(0, 10);
  const applicable = rates
    .filter((r) => r.code === code && r.effectiveFrom <= day)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const rate = applicable[0];
  if (!rate) throw new Error(`No ${code} rate effective on ${day}`);
  return rate.ratePpm;
}

/** Only the "standard" category is taxable; zero-rated and exempt supplies carry no GST/QST. */
export function isTaxable(category: TaxCategory): boolean {
  return category === "standard";
}

export interface TaxResult {
  gstCents: Cents;
  qstCents: Cents;
  gstRatePpm: number;
  qstRatePpm: number;
}

/** Invoice-level taxes on the total taxable base (after discounts), each rounded half-up. */
export function computeTaxes(taxableBaseCents: number, at: Date): TaxResult {
  const gstRatePpm = rateOn("GST", at);
  const qstRatePpm = rateOn("QST", at);
  const base = cents(Math.max(0, taxableBaseCents));
  return {
    gstCents: applyRatePpm(base, gstRatePpm),
    qstCents: applyRatePpm(base, qstRatePpm),
    gstRatePpm,
    qstRatePpm,
  };
}
