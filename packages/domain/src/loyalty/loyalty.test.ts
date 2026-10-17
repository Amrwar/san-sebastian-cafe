import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOYALTY_RULES,
  isCardCode,
  isRewardEligible,
  normalizeCardCode,
  planEarn,
  planReversal,
  rewardExpiry,
  rewardValueCents,
  stampsForPurchase,
  type EarnLine,
} from "./loyalty";

const rules = DEFAULT_LOYALTY_RULES;
const drink = (over: Partial<EarnLine> = {}): EarnLine => ({
  id: "l1",
  productId: "latte",
  variantId: "large",
  quantity: 1,
  isDrink: true,
  loyaltyQualifying: true,
  paidCents: 450,
  freeUnits: 0,
  ...over,
});

describe("stampsForPurchase", () => {
  it("counts drink units, not orders: five drinks in one purchase earn five stamps", () => {
    expect(stampsForPurchase([drink({ quantity: 5, paidCents: 2250 })], rules).total).toBe(5);
    expect(
      stampsForPurchase(
        [drink({ quantity: 2, paidCents: 900 }), drink({ id: "l2", quantity: 3, paidCents: 1350 })],
        rules,
      ).total,
    ).toBe(5);
  });

  it("explains every unit that earns nothing", () => {
    const result = stampsForPurchase(
      [
        drink({ id: "muffin", isDrink: false, loyaltyQualifying: false, quantity: 2 }),
        drink({ id: "water", productId: "water", loyaltyQualifying: false }),
        drink({ id: "free", quantity: 2, paidCents: 450, freeUnits: 1 }),
      ],
      rules,
    );
    expect(result.total).toBe(1);
    expect(result.lines).toEqual([
      { id: "muffin", stamps: 0, notCounted: [{ quantity: 2, reason: "not_qualifying" }] },
      { id: "water", stamps: 0, notCounted: [{ quantity: 1, reason: "not_qualifying" }] },
      { id: "free", stamps: 1, notCounted: [{ quantity: 1, reason: "reward_drink" }] },
    ]);
  });

  it("never stamps the free reward drink itself", () => {
    expect(stampsForPurchase([drink({ paidCents: 0, freeUnits: 1 })], rules).lines[0]).toEqual({
      id: "l1",
      stamps: 0,
      notCounted: [{ quantity: 1, reason: "reward_drink" }],
    });
  });

  it("applies program exclusions for products and sizes", () => {
    const custom = { ...rules, excludedProductIds: ["latte"], excludedVariantIds: ["small"] };
    expect(stampsForPurchase([drink()], custom).lines[0]!.notCounted[0]!.reason).toBe(
      "excluded_product",
    );
    expect(
      stampsForPurchase([drink({ productId: "mocha", variantId: "small" })], custom).lines[0]!
        .notCounted[0]!.reason,
    ).toBe("excluded_size");
  });

  it("does not stamp drinks that were fully discounted, and honours a minimum paid amount", () => {
    expect(stampsForPurchase([drink({ quantity: 2, paidCents: 0 })], rules).lines[0]).toEqual({
      id: "l1",
      stamps: 0,
      notCounted: [{ quantity: 2, reason: "not_paid" }],
    });
    const min = { ...rules, minPaidCentsPerDrink: 200 };
    expect(stampsForPurchase([drink({ quantity: 3, paidCents: 450 })], min).lines[0]).toEqual({
      id: "l1",
      stamps: 2,
      notCounted: [{ quantity: 1, reason: "not_paid" }],
    });
  });

  it("caps stamps per purchase when the program sets a limit", () => {
    const capped = { ...rules, maxStampsPerPurchase: 6 };
    const result = stampsForPurchase(
      [drink({ quantity: 4, paidCents: 1800 }), drink({ id: "l2", quantity: 4, paidCents: 1800 })],
      capped,
    );
    expect(result.total).toBe(6);
    expect(result.lines[1]).toEqual({
      id: "l2",
      stamps: 2,
      notCounted: [{ quantity: 2, reason: "purchase_limit" }],
    });
  });
});

describe("planEarn", () => {
  it.each([
    [0, 4, 0, 4],
    [0, 5, 1, 0],
    [4, 1, 1, 0],
    [4, 2, 1, 1],
    [0, 9, 1, 4],
    [0, 10, 2, 0],
    [3, 12, 3, 0],
  ])("balance %i + %i stamps → %i reward(s), %i carried", (balance, stamps, rewards, rest) => {
    expect(planEarn({ balance, debt: 0 }, stamps, 5)).toMatchObject({
      rewards,
      balance: rest,
      repaid: 0,
    });
  });

  it("settles stamps owed before filling the card", () => {
    expect(planEarn({ balance: 0, debt: 3 }, 2, 5)).toEqual({
      repaid: 2,
      rewards: 0,
      balance: 0,
      debt: 1,
    });
    expect(planEarn({ balance: 0, debt: 3 }, 8, 5)).toEqual({
      repaid: 3,
      rewards: 1,
      balance: 0,
      debt: 0,
    });
  });

  it("uses the configured threshold", () => {
    expect(planEarn({ balance: 6, debt: 0 }, 2, 8)).toMatchObject({ rewards: 1, balance: 0 });
  });
});

describe("planReversal", () => {
  it("takes stamps from the balance first", () => {
    expect(planReversal({ balance: 3, debt: 0 }, 2, [5], "carry_forward")).toMatchObject({
      fromBalance: 2,
      revokedRewards: 0,
      debtAdded: 0,
      balance: 1,
    });
  });

  it("revokes an unused reward to cover the rest, returning its unused stamps", () => {
    expect(planReversal({ balance: 1, debt: 0 }, 3, [5], "carry_forward")).toEqual({
      fromBalance: 3,
      revokedRewards: 1,
      restored: 5,
      debtAdded: 0,
      forgiven: 0,
      balance: 3,
      debt: 0,
    });
  });

  it("records stamps owed when the reward was already used (carry forward)", () => {
    expect(planReversal({ balance: 0, debt: 0 }, 5, [], "carry_forward")).toEqual({
      fromBalance: 0,
      revokedRewards: 0,
      restored: 0,
      debtAdded: 5,
      forgiven: 0,
      balance: 0,
      debt: 5,
    });
  });

  it("writes the shortfall off under the forgive policy", () => {
    expect(planReversal({ balance: 1, debt: 0 }, 4, [], "forgive")).toMatchObject({
      fromBalance: 1,
      debtAdded: 0,
      forgiven: 3,
      balance: 0,
      debt: 0,
    });
  });

  it("never produces a negative balance", () => {
    for (let balance = 0; balance < 6; balance++)
      for (let stamps = 0; stamps < 12; stamps++) {
        const r = planReversal({ balance, debt: 0 }, stamps, [5, 5], "carry_forward");
        expect(r.balance).toBeGreaterThanOrEqual(0);
        expect(r.fromBalance + r.debtAdded + r.forgiven).toBe(stamps);
        expect(r.balance).toBe(balance + r.restored - r.fromBalance);
      }
  });
});

describe("rewards", () => {
  it("expires only when the program sets an expiry", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    expect(rewardExpiry(issued, null)).toBeNull();
    expect(rewardExpiry(issued, 90)?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("checks product flags and program exclusions", () => {
    const latte = { id: "latte", isDrink: true, rewardEligible: true };
    const r = { rewardExcludedProductIds: [], rewardExcludedVariantIds: ["xl"] };
    expect(isRewardEligible(latte, "large", r)).toBe(true);
    expect(isRewardEligible(latte, "xl", r)).toBe(false);
    expect(isRewardEligible({ ...latte, rewardEligible: false }, "large", r)).toBe(false);
    expect(isRewardEligible({ ...latte, isDrink: false }, "large", r)).toBe(false);
  });

  it("values the free drink at its size price, extras only when covered, up to the cap", () => {
    const plain = { valueCapCents: null, coversModifiers: false };
    expect(rewardValueCents(450, 525, plain)).toBe(450);
    expect(rewardValueCents(450, 525, { ...plain, coversModifiers: true })).toBe(525);
    expect(rewardValueCents(450, 525, { valueCapCents: 400, coversModifiers: true })).toBe(400);
  });
});

describe("card codes", () => {
  it("normalizes and validates what staff type", () => {
    expect(normalizeCardCode("ab cd-ef 23")).toBe("ABCDEF23");
    expect(isCardCode("abcd-ef23")).toBe(true);
    expect(isCardCode("ABCDEF2O")).toBe(false); // O is not in the alphabet
    expect(isCardCode("ABC")).toBe(false);
  });
});
