import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConfiguredProduct } from "../catalog/configuration";
import {
  allocate,
  computeQuote,
  TIP_PRESETS_BPS,
  type PromotionRule,
  type TipInput,
} from "./quote";
import { computeTaxes } from "./tax";

/*
 * Property tests for the price quote: whatever the cart, promotion, free drink, fulfilment or tip,
 * the totals add up to the cent, nothing is negative, discounts never exceed what they apply to,
 * and taxes are exactly those of the taxable base.
 */

const now = new Date("2026-10-11T15:00:00Z");

const latte: ConfiguredProduct = {
  id: "latte",
  categoryId: "drinks",
  availability: "available",
  taxCategory: "standard",
  isDrink: true,
  loyaltyQualifying: true,
  rewardEligible: true,
  variants: [
    { id: "latte-s", priceCents: 450, isDefault: true, availability: "available" },
    { id: "latte-l", priceCents: 550, isDefault: false, availability: "available" },
  ],
  groups: [
    {
      id: "milk",
      selection: "single",
      minSelected: 1,
      maxSelected: 1,
      options: [
        { id: "whole", priceDeltaCents: 0, isDefault: true, availability: "available" },
        { id: "oat", priceDeltaCents: 75, isDefault: false, availability: "available" },
      ],
    },
    {
      id: "syrups",
      selection: "multiple",
      minSelected: 0,
      maxSelected: 2,
      options: [
        { id: "vanilla", priceDeltaCents: 60, isDefault: false, availability: "available" },
        { id: "caramel", priceDeltaCents: 60, isDefault: false, availability: "available" },
      ],
    },
  ],
};

const croissant: ConfiguredProduct = {
  id: "croissant",
  categoryId: "bakery",
  availability: "available",
  taxCategory: "standard",
  isDrink: false,
  loyaltyQualifying: false,
  rewardEligible: false,
  variants: [{ id: "croissant-1", priceCents: 375, isDefault: true, availability: "available" }],
  groups: [],
};

const beans: ConfiguredProduct = {
  id: "beans",
  categoryId: "retail",
  availability: "available",
  taxCategory: "zero_rated",
  isDrink: false,
  loyaltyQualifying: false,
  rewardEligible: false,
  variants: [{ id: "beans-340", priceCents: 2000, isDefault: true, availability: "available" }],
  groups: [],
};

const catalog = new Map([latte, croissant, beans].map((p) => [p.id, p]));

const latteLine = fc.record({
  productId: fc.constant("latte"),
  variantId: fc.constantFrom("latte-s", "latte-l"),
  optionIds: fc
    .tuple(fc.constantFrom("whole", "oat"), fc.subarray(["vanilla", "caramel"]))
    .map(([milk, syrups]) => [milk, ...syrups]),
  quantity: fc.integer({ min: 1, max: 6 }),
});
const simpleLine = fc.record({
  productId: fc.constantFrom("croissant", "beans"),
  variantId: fc.constant(""),
  optionIds: fc.constant<string[]>([]),
  quantity: fc.integer({ min: 1, max: 6 }),
});
const lines = fc.array(fc.oneof(latteLine, simpleLine), { minLength: 1, maxLength: 6 }).map((ls) =>
  ls.map((l, i) => ({
    ...l,
    lineId: `l${i}`,
    variantId: l.variantId || (l.productId === "croissant" ? "croissant-1" : "beans-340"),
  })),
);

const promotion: fc.Arbitrary<PromotionRule | null> = fc.option(
  fc.record({
    id: fc.constant("promo"),
    code: fc.constant("CODE"),
    kind: fc.constantFrom("percent_off" as const, "amount_off" as const),
    value: fc.integer({ min: 1, max: 10_000 }),
    scope: fc.constantFrom("order" as const, "product" as const, "category" as const),
    targetIds: fc.constantFrom(["latte"], ["croissant"], ["drinks"], ["retail"], []),
    minSubtotalCents: fc.constantFrom(0, 500, 5000),
    startsAt: fc.constant(new Date("2026-01-01T00:00:00Z")),
    endsAt: fc.constant(null),
    isActive: fc.constant(true),
    stackableWithRewards: fc.boolean(),
  }),
  { nil: null },
);

const tip: fc.Arbitrary<TipInput> = fc.oneof(
  fc.constant({ kind: "none" as const }),
  fc
    .constantFrom(...TIP_PRESETS_BPS)
    .map((bps) => ({ kind: "percent" as const, basisPoints: bps })),
  fc.integer({ min: 0, max: 5000 }).map((c) => ({ kind: "amount" as const, cents: c })),
);

const scenario = fc.record({
  lines,
  promotion,
  reward: fc.option(
    fc.record({
      rewardId: fc.constant("r1"),
      valueCapCents: fc.option(fc.integer({ min: 100, max: 1000 }), { nil: null }),
      coversModifiers: fc.boolean(),
    }),
    { nil: null },
  ),
  delivery: fc.boolean(),
  tip,
});

const sum = (vs: number[]) => vs.reduce((s, v) => s + v, 0);

describe("computeQuote (properties)", () => {
  it("adds up to the cent, with nothing negative and discounts within bounds", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const q = computeQuote({
          lines: s.lines,
          catalog,
          promotion: s.promotion,
          reward: s.reward,
          fulfilment: s.delivery
            ? { method: "delivery", feeCents: 400, minimumOrderCents: 1500 }
            : { method: "pickup" },
          tip: s.tip,
          now,
        });
        // The total is exactly its parts.
        expect(q.totalCents).toBe(
          q.subtotalCents -
            q.discountCents -
            q.rewardDiscountCents +
            q.deliveryFeeCents +
            q.gstCents +
            q.qstCents +
            q.tipCents,
        );
        for (const v of [
          q.subtotalCents,
          q.discountCents,
          q.rewardDiscountCents,
          q.deliveryFeeCents,
          q.gstCents,
          q.qstCents,
          q.tipCents,
          q.totalCents,
        ])
          expect(v).toBeGreaterThanOrEqual(0);
        // Lines carry exactly the order's discounts, and no line is discounted below zero.
        expect(sum(q.lines.map((l) => l.discountCents))).toBe(q.discountCents);
        expect(sum(q.lines.map((l) => l.rewardDiscountCents))).toBe(q.rewardDiscountCents);
        for (const l of q.lines)
          expect(l.discountCents + l.rewardDiscountCents).toBeLessThanOrEqual(l.lineTotalCents);
        expect(q.subtotalCents).toBe(sum(q.lines.map((l) => l.lineTotalCents)));
        // At most one free drink.
        expect(q.lines.filter((l) => l.rewardDiscountCents > 0).length).toBeLessThanOrEqual(1);
        // Taxes are exactly those of the taxable base, which excludes zero-rated items.
        const taxes = computeTaxes(q.taxableCents, now);
        expect([q.gstCents, q.qstCents]).toEqual([taxes.gstCents, taxes.qstCents]);
        const beansNet = sum(
          q.lines
            .filter((l) => l.productId === "beans")
            .map((l) => l.lineTotalCents - l.discountCents - l.rewardDiscountCents),
        );
        expect(q.taxableCents).toBeLessThanOrEqual(
          q.subtotalCents - q.discountCents - q.rewardDiscountCents - beansNet + q.deliveryFeeCents,
        );
        // Tip suggestions are on the pre-tax amount.
        expect(q.tipBaseCents).toBe(q.subtotalCents - q.discountCents - q.rewardDiscountCents);
        for (const t of q.tipSuggestions)
          expect(Math.abs(t.cents - (q.tipBaseCents * t.basisPoints) / 10_000)).toBeLessThanOrEqual(
            0.5,
          );
      }),
      { numRuns: 2000 },
    );
  });
});

describe("allocate (properties)", () => {
  it("splits an amount exactly, in proportion, within one cent per share", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 0, max: 100_000 }),
        (weights, raw) => {
          const total = sum(weights);
          const amount = Math.min(raw, total);
          const shares = allocate(amount, weights);
          expect(sum(shares)).toBe(total === 0 ? 0 : amount);
          if (total > 0)
            shares.forEach((s, i) => {
              expect(Math.abs(s - (amount * (weights[i] ?? 0)) / total)).toBeLessThan(1);
              expect(s).toBeGreaterThanOrEqual(0);
            });
        },
      ),
    );
  });
});
