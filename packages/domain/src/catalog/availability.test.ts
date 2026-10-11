import { describe, expect, it } from "vitest";
import { computeQuote } from "../pricing/quote";
import { productAt, unavailableReason, withinWindows } from "./availability";
import {
  defaultSelection,
  unitPriceCents,
  validateSelection,
  type ConfiguredProduct,
} from "./configuration";

// Monday 2026-10-12, 09:00 and 13:00 EDT.
const mondayMorning = new Date("2026-10-12T13:00:00Z");
const mondayAfternoon = new Date("2026-10-12T17:00:00Z");

const espresso: ConfiguredProduct = {
  id: "esp",
  categoryId: "drinks",
  availability: "available",
  taxCategory: "standard",
  isDrink: true,
  loyaltyQualifying: true,
  rewardEligible: true,
  variants: [
    {
      id: "single",
      priceCents: 300,
      isDefault: true,
      availability: "available",
      // A single espresso can't be iced, and the extra shot costs less on a single.
      optionRules: [
        { optionId: "iced", priceDeltaCents: null, excluded: true },
        { optionId: "shot", priceDeltaCents: 50, excluded: false },
      ],
    },
    { id: "double", priceCents: 400, isDefault: false, availability: "available" },
  ],
  groups: [
    {
      id: "temp",
      selection: "single",
      minSelected: 1,
      maxSelected: 1,
      options: [
        { id: "iced", priceDeltaCents: 0, isDefault: true, availability: "available" },
        { id: "hot", priceDeltaCents: 0, isDefault: false, availability: "available" },
      ],
    },
    {
      id: "extras",
      selection: "multiple",
      minSelected: 0,
      maxSelected: 2,
      options: [
        { id: "shot", priceDeltaCents: 100, isDefault: false, availability: "available" },
        {
          id: "cream",
          priceDeltaCents: 75,
          isDefault: false,
          availability: "available",
          unavailableUntil: new Date("2026-10-12T15:00:00Z"),
        },
      ],
    },
  ],
};

describe("size-specific option rules", () => {
  it("rejects combinations that aren't allowed for the chosen size", () => {
    const issues = validateSelection(espresso, { variantId: "single", optionIds: ["iced"] }, 1);
    expect(issues).toContainEqual({ code: "option_not_allowed_for_size", ref: "iced" });
    expect(validateSelection(espresso, { variantId: "double", optionIds: ["iced"] }, 1)).toEqual(
      [],
    );
  });

  it("uses the size-specific price when one is configured", () => {
    expect(unitPriceCents(espresso, { variantId: "single", optionIds: ["hot", "shot"] })).toBe(350);
    expect(unitPriceCents(espresso, { variantId: "double", optionIds: ["hot", "shot"] })).toBe(500);
  });

  it("never pre-selects a default that isn't allowed for the default size", () => {
    expect(defaultSelection(espresso)).toEqual({ variantId: "single", optionIds: ["hot"] });
  });
});

describe("availability schedules and temporary disabling", () => {
  const breakfast: ConfiguredProduct = {
    ...espresso,
    id: "bfast",
    availabilityWindows: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startMinute: 7 * 60,
      endMinute: 11 * 60,
    })),
  };

  it("honours weekly windows in local time", () => {
    expect(withinWindows(breakfast.availabilityWindows, mondayMorning)).toBe(true);
    expect(withinWindows(breakfast.availabilityWindows, mondayAfternoon)).toBe(false);
    expect(withinWindows([], mondayAfternoon)).toBe(true);
    expect(unavailableReason(breakfast, mondayAfternoon)).toBe("outside_hours");
  });

  it("treats a temporary disable as sold out until it lapses", () => {
    const disabled = { ...espresso, unavailableUntil: new Date("2026-10-12T14:00:00Z") };
    expect(unavailableReason(disabled, mondayMorning)).toBe("temporarily_unavailable");
    expect(unavailableReason(disabled, mondayAfternoon)).toBeNull();
  });

  it("folds availability into pricing for the pickup time, including options", () => {
    const quote = (at: Date) =>
      computeQuote({
        lines: [
          {
            lineId: "a",
            productId: "esp",
            variantId: "double",
            optionIds: ["hot", "cream"],
            quantity: 1,
          },
        ],
        catalog: new Map([["esp", productAt(espresso, at)]]),
        fulfilment: { method: "pickup" },
        tip: { kind: "none" },
        now: at,
      });
    expect(quote(mondayMorning).lines[0]?.issues).toContainEqual({
      code: "option_unavailable",
      ref: "cream",
    });
    expect(quote(mondayAfternoon).lines[0]?.valid).toBe(true);
  });
});
