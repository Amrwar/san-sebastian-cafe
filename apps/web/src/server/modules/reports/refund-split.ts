/**
 * What a refund gives back, split like the order it refunds. Refunds store only an amount, so the
 * split is pro rata to the order's own breakdown (goods, GST, QST, tip). It is computed on the
 * running total of an order's refunds, so several partial refunds that add up to the whole order
 * return exactly the order's taxes and tip, to the cent.
 */
export interface MoneySplit {
  goodsCents: number;
  gstCents: number;
  qstCents: number;
  tipCents: number;
}

const PARTS = ["goodsCents", "gstCents", "qstCents", "tipCents"] as const;
const NONE: MoneySplit = { goodsCents: 0, gstCents: 0, qstCents: 0, tipCents: 0 };

/** Splits `amount` (≤ the order total) pro rata, largest remainder first, summing exactly. */
export function splitProRata(order: MoneySplit, amount: number): MoneySplit {
  const total = PARTS.reduce((s, k) => s + order[k], 0);
  if (amount <= 0 || total <= 0) return { ...NONE };
  const capped = Math.min(amount, total);
  const shares = PARTS.map((key, index) => {
    const exact = (order[key] * capped) / total;
    return { key, index, cents: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = capped - shares.reduce((s, p) => s + p.cents, 0);
  // Ties go to the earlier part (goods, then GST, QST, tip) so results are deterministic.
  for (const share of [...shares].sort((a, b) => b.rest - a.rest || a.index - b.index)) {
    if (left === 0) break;
    share.cents += 1;
    left -= 1;
  }
  const out = { ...NONE };
  for (const share of shares) out[share.key] = share.cents;
  return out;
}

/**
 * Splits each of an order's refunds (in settlement order) as the difference between the split of
 * the running totals after and before it.
 */
export function splitRefunds(order: MoneySplit, amounts: readonly number[]): MoneySplit[] {
  let before = { ...NONE };
  let running = 0;
  return amounts.map((amount) => {
    running += amount;
    const after = splitProRata(order, running);
    const part = { ...NONE };
    for (const key of PARTS) part[key] = after[key] - before[key];
    before = after;
    return part;
  });
}
