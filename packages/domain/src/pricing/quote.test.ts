import { describe, expect, it } from "vitest";
import type { ConfiguredProduct } from "../catalog/configuration";
import { allocate, computeQuote, type PromotionRule, type QuoteInput } from "./quote";

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
    { id: "latte-xl", priceCents: 650, isDefault: false, availability: "sold_out" },
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
        { id: "almond", priceDeltaCents: 75, isDefault: false, availability: "sold_out" },
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
        { id: "hazelnut", priceDeltaCents: 60, isDefault: false, availability: "available" },
      ],
    },
  ],
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

const catalog = new Map([
  [latte.id, latte],
  [beans.id, beans],
]);

function quote(overrides: Partial<QuoteInput> = {}) {
  return computeQuote({
    lines: [
      { lineId: "a", productId: "latte", variantId: "latte-s", optionIds: ["whole"], quantity: 1 },
    ],
    catalog,
    fulfilment: { method: "pickup" },
    tip: { kind: "none" },
    now,
    ...overrides,
  });
}

const promo = (p: Partial<PromotionRule> = {}): PromotionRule => ({
  id: "promo",
  code: "TEN",
  kind: "percent_off",
  value: 1000,
  scope: "order",
  targetIds: [],
  minSubtotalCents: 0,
  startsAt: new Date("2026-01-01T00:00:00Z"),
  endsAt: null,
  isActive: true,
  stackableWithRewards: false,
  ...p,
});

describe("computeQuote — pricing", () => {
  it("prices variant + modifiers and applies GST/QST on the taxable base", () => {
    const q = quote({
      lines: [
        {
          lineId: "a",
          productId: "latte",
          variantId: "latte-l",
          optionIds: ["oat", "vanilla"],
          quantity: 2,
        },
      ],
    });
    expect(q.lines[0]).toMatchObject({ unitPriceCents: 685, lineTotalCents: 1370, valid: true });
    expect(q.subtotalCents).toBe(1370);
    expect(q.gstCents).toBe(69); // 68.5 → 69
    expect(q.qstCents).toBe(137); // 136.6575 → 137
    expect(q.totalCents).toBe(1370 + 69 + 137);
    expect(q.canCheckout).toBe(true);
  });

  it("does not tax zero-rated items", () => {
    const q = quote({
      lines: [
        { lineId: "b", productId: "beans", variantId: "beans-340", optionIds: [], quantity: 1 },
      ],
    });
    expect(q).toMatchObject({ subtotalCents: 2000, gstCents: 0, qstCents: 0, totalCents: 2000 });
  });

  it("ignores any client-side notion of price — only ids and quantities exist in the input", () => {
    const q = quote();
    expect(q.lines[0]?.unitPriceCents).toBe(450);
  });

  it("flags unavailable or invalid selections and excludes them from totals", () => {
    const q = quote({
      lines: [
        {
          lineId: "x",
          productId: "latte",
          variantId: "latte-xl",
          optionIds: ["whole"],
          quantity: 1,
        },
        {
          lineId: "y",
          productId: "latte",
          variantId: "latte-s",
          optionIds: ["almond"],
          quantity: 1,
        },
        { lineId: "z", productId: "latte", variantId: "latte-s", optionIds: [], quantity: 1 },
        {
          lineId: "w",
          productId: "latte",
          variantId: "latte-s",
          optionIds: ["whole", "vanilla", "caramel", "hazelnut"],
          quantity: 1,
        },
        { lineId: "v", productId: "ghost", variantId: "?", optionIds: [], quantity: 1 },
        {
          lineId: "u",
          productId: "latte",
          variantId: "latte-s",
          optionIds: ["whole"],
          quantity: 0,
        },
      ],
    });
    const codes = Object.fromEntries(q.lines.map((l) => [l.lineId, l.issues.map((i) => i.code)]));
    expect(codes.x).toContain("variant_unavailable");
    expect(codes.y).toContain("option_unavailable");
    expect(codes.z).toContain("group_below_minimum");
    expect(codes.w).toContain("group_above_maximum");
    expect(codes.v).toContain("product_unavailable");
    expect(codes.u).toContain("quantity_invalid");
    expect(q.subtotalCents).toBe(0);
    expect(q.issues).toContain("invalid_lines");
    expect(q.canCheckout).toBe(false);
  });

  it("reports an empty cart", () => {
    expect(quote({ lines: [] }).issues).toContain("cart_empty");
  });
});

describe("computeQuote — tips (Québec: suggestions on the pre-tax amount)", () => {
  it("computes suggestions on the pre-tax subtotal after discounts", () => {
    const q = quote({ tip: { kind: "percent", basisPoints: 1500 } });
    expect(q.tipBaseCents).toBe(450);
    expect(q.tipSuggestions).toEqual([
      { basisPoints: 1000, cents: 45 },
      { basisPoints: 1500, cents: 68 },
      { basisPoints: 1800, cents: 81 },
    ]);
    expect(q.tipCents).toBe(68);
    // Tips are not taxed.
    expect(q.totalCents).toBe(450 + 23 + 45 + 68);
  });

  it("accepts custom amounts within limits and rejects others", () => {
    expect(quote({ tip: { kind: "amount", cents: 125 } }).tipCents).toBe(125);
    expect(quote({ tip: { kind: "amount", cents: -1 } }).issues).toContain("tip_invalid");
    expect(quote({ tip: { kind: "percent", basisPoints: 2500 } }).issues).toContain("tip_invalid");
  });
});

describe("computeQuote — promotions", () => {
  it("applies an order-level percentage and taxes the discounted amount", () => {
    const q = quote({ promotion: promo() });
    expect(q.promotion).toEqual({ id: "promo", status: "applied", discountCents: 45 });
    expect(q.taxableCents).toBe(405);
    expect(q.totalCents).toBe(405 + 20 + 40);
  });

  it("limits product-scoped promotions to matching lines", () => {
    const q = quote({
      lines: [
        {
          lineId: "a",
          productId: "latte",
          variantId: "latte-s",
          optionIds: ["whole"],
          quantity: 1,
        },
        { lineId: "b", productId: "beans", variantId: "beans-340", optionIds: [], quantity: 1 },
      ],
      promotion: promo({ scope: "product", targetIds: ["beans"], kind: "amount_off", value: 300 }),
    });
    expect(q.lines.find((l) => l.lineId === "b")?.discountCents).toBe(300);
    expect(q.lines.find((l) => l.lineId === "a")?.discountCents).toBe(0);
  });

  it.each([
    [{ isActive: false }, "inactive"],
    [{ startsAt: new Date("2027-01-01T00:00:00Z") }, "not_started"],
    [{ endsAt: new Date("2026-10-01T00:00:00Z") }, "expired"],
    [{ minSubtotalCents: 1000 }, "below_minimum"],
    [{ scope: "category" as const, targetIds: ["pastries"] }, "no_eligible_items"],
  ])("explains why a promotion does not apply (%o → %s)", (override, status) => {
    const q = quote({ promotion: promo(override) });
    expect(q.promotion?.status).toBe(status);
    expect(q.discountCents).toBe(0);
  });

  it("reports unknown codes", () => {
    expect(quote({ promotionCodeNotFound: true }).promotion?.status).toBe("not_found");
  });

  it("never discounts more than the eligible amount", () => {
    const q = quote({ promotion: promo({ kind: "amount_off", value: 99_999 }) });
    expect(q.discountCents).toBe(450);
    expect(q.totalCents).toBe(0);
  });
});

describe("computeQuote — rewards (free drink)", () => {
  it("makes the base drink free but still charges extras", () => {
    const q = quote({
      lines: [
        { lineId: "a", productId: "latte", variantId: "latte-l", optionIds: ["oat"], quantity: 2 },
      ],
      reward: { rewardId: "r1", valueCapCents: null },
    });
    expect(q.reward).toEqual({
      rewardId: "r1",
      status: "applied",
      lineId: "a",
      discountCents: 550,
    });
    expect(q.subtotalCents - q.rewardDiscountCents).toBe(1250 - 550);
  });

  it("respects a value cap", () => {
    const q = quote({ reward: { rewardId: "r1", valueCapCents: 300 } });
    expect(q.rewardDiscountCents).toBe(300);
  });

  it("does not apply to non-eligible items", () => {
    const q = quote({
      lines: [
        { lineId: "b", productId: "beans", variantId: "beans-340", optionIds: [], quantity: 1 },
      ],
      reward: { rewardId: "r1", valueCapCents: null },
    });
    expect(q.reward?.status).toBe("no_eligible_item");
  });

  it("does not combine with a promotion unless the promotion allows it", () => {
    const blocked = quote({ reward: { rewardId: "r1", valueCapCents: null }, promotion: promo() });
    expect(blocked.promotion?.status).toBe("not_stackable_with_reward");
    const stacked = quote({
      lines: [
        {
          lineId: "a",
          productId: "latte",
          variantId: "latte-s",
          optionIds: ["whole"],
          quantity: 2,
        },
      ],
      reward: { rewardId: "r1", valueCapCents: null },
      promotion: promo({ stackableWithRewards: true }),
    });
    expect(stacked.promotion?.discountCents).toBe(45); // 10% of (900 − 450)
  });
});

describe("computeQuote — delivery", () => {
  it("adds a taxable delivery fee and enforces the minimum", () => {
    const q = quote({ fulfilment: { method: "delivery", feeCents: 300, minimumOrderCents: 1000 } });
    expect(q.deliveryFeeCents).toBe(300);
    expect(q.taxableCents).toBe(750);
    expect(q.issues).toContain("delivery_minimum_not_met");
  });
});

describe("allocate", () => {
  it("splits exactly, proportionally", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(45, [450, 0])).toEqual([45, 0]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
  });
});
