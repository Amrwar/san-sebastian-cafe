import { describe, expect, it } from "vitest";
import { splitProRata, splitRefunds, type MoneySplit } from "./refund-split";

// 10,00 $ of goods, GST 0,50 $, QST 1,00 $, tip 1,50 $ → 13,00 $.
const order: MoneySplit = { goodsCents: 1000, gstCents: 50, qstCents: 100, tipCents: 150 };
const sum = (s: MoneySplit) => s.goodsCents + s.gstCents + s.qstCents + s.tipCents;

describe("splitProRata", () => {
  it("returns the whole breakdown for a full refund and nothing for zero", () => {
    expect(splitProRata(order, 1300)).toEqual(order);
    expect(splitProRata(order, 0)).toEqual({
      goodsCents: 0,
      gstCents: 0,
      qstCents: 0,
      tipCents: 0,
    });
  });

  it("always sums to the refunded amount", () => {
    for (let amount = 1; amount <= 1300; amount++)
      expect(sum(splitProRata(order, amount))).toBe(amount);
  });

  it("splits in proportion", () => {
    expect(splitProRata(order, 650)).toEqual({
      goodsCents: 500,
      gstCents: 25,
      qstCents: 50,
      tipCents: 75,
    });
  });

  it("handles an order with no tip or no tax", () => {
    expect(splitProRata({ goodsCents: 300, gstCents: 0, qstCents: 0, tipCents: 0 }, 120)).toEqual({
      goodsCents: 120,
      gstCents: 0,
      qstCents: 0,
      tipCents: 0,
    });
  });
});

describe("splitRefunds", () => {
  it("partial refunds that add up to the order return exactly its taxes and tip", () => {
    const parts = splitRefunds(order, [333, 333, 334, 300]);
    expect(parts.map(sum)).toEqual([333, 333, 334, 300]);
    const totals = parts.reduce(
      (t, p) => ({
        goodsCents: t.goodsCents + p.goodsCents,
        gstCents: t.gstCents + p.gstCents,
        qstCents: t.qstCents + p.qstCents,
        tipCents: t.tipCents + p.tipCents,
      }),
      { goodsCents: 0, gstCents: 0, qstCents: 0, tipCents: 0 },
    );
    expect(totals).toEqual(order);
    for (const p of parts) for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
