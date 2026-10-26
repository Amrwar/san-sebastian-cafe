import { describe, expect, it } from "vitest";
import { catalogAt, productAt, unavailableReason, withinWindows } from "./availability";
import { defaultSelection, validateSelection, type ConfiguredProduct } from "./configuration";

/* Edge cases of product availability and drink configuration. */

const base: ConfiguredProduct = {
  id: "tea",
  categoryId: "drinks",
  availability: "available",
  taxCategory: "standard",
  isDrink: true,
  loyaltyQualifying: true,
  rewardEligible: true,
  variants: [
    { id: "s", priceCents: 300, isDefault: true, availability: "sold_out" },
    { id: "l", priceCents: 400, isDefault: false, availability: "available" },
  ],
  groups: [
    {
      id: "leaf",
      selection: "single",
      minSelected: 1,
      maxSelected: 1,
      options: [
        { id: "green", priceDeltaCents: 0, isDefault: false, availability: "available" },
        { id: "black", priceDeltaCents: 0, isDefault: false, availability: "available" },
      ],
    },
    {
      id: "extras",
      selection: "multiple",
      minSelected: 0,
      maxSelected: 1,
      options: [
        { id: "honey", priceDeltaCents: 50, isDefault: false, availability: "sold_out" },
        { id: "lemon", priceDeltaCents: 25, isDefault: false, availability: "available" },
      ],
    },
  ],
};

// Monday 2026-10-12, 09:00 EDT.
const monday9 = new Date("2026-10-12T13:00:00Z");

describe("availability", () => {
  it("names why a product can't be ordered", () => {
    expect(unavailableReason({ ...base, availability: "hidden" }, monday9)).toBe("hidden");
    expect(unavailableReason({ ...base, availability: "sold_out" }, monday9)).toBe("sold_out");
    expect(
      unavailableReason({ ...base, unavailableUntil: new Date("2026-10-12T15:00:00Z") }, monday9),
    ).toBe("temporarily_unavailable");
    // A past "unavailable until" no longer applies.
    expect(
      unavailableReason({ ...base, unavailableUntil: new Date("2026-10-12T12:00:00Z") }, monday9),
    ).toBeNull();
    expect(
      unavailableReason(
        { ...base, availabilityWindows: [{ weekday: 1, startMinute: 600, endMinute: 900 }] },
        monday9,
      ),
    ).toBe("outside_hours");
  });

  it("treats a window as [start, end): open at its first minute, closed at its last", () => {
    const window = [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }];
    expect(withinWindows(window, monday9)).toBe(true);
    expect(withinWindows(window, new Date("2026-10-12T14:00:00Z"))).toBe(false);
    expect(withinWindows([], monday9)).toBe(true);
    expect(withinWindows(undefined, monday9)).toBe(true);
  });

  it("folds hiding and temporary options into what can be ordered, product by product", () => {
    const hidden = productAt({ ...base, availability: "hidden" }, monday9);
    expect(hidden).toMatchObject({ availability: "hidden", unavailableReason: "hidden" });
    const withPause = {
      ...base,
      groups: [
        {
          ...base.groups[1]!,
          options: [
            {
              id: "lemon",
              priceDeltaCents: 25,
              isDefault: false,
              availability: "available" as const,
              unavailableUntil: new Date("2026-10-12T14:00:00Z"),
            },
          ],
        },
      ],
    };
    const map = catalogAt(new Map([["tea", withPause]]), monday9);
    expect(map.get("tea")?.groups[0]?.options[0]?.availability).toBe("sold_out");
    // Later, the option is back.
    const later = catalogAt(new Map([["tea", withPause]]), new Date("2026-10-12T15:00:00Z"));
    expect(later.get("tea")?.groups[0]?.options[0]?.availability).toBe("available");
  });
});

describe("drink configuration", () => {
  it("starts on an available size and on the first usable options of a required group", () => {
    expect(defaultSelection(base)).toEqual({ variantId: "l", optionIds: ["green"] });
    // Nothing available: still a well-formed selection (validation then explains the problem).
    const none = {
      ...base,
      variants: base.variants.map((v) => ({ ...v, availability: "sold_out" as const })),
    };
    expect(defaultSelection(none).variantId).toBe("s");
  });

  it("reports every problem with a selection", () => {
    const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code).sort();
    expect(codes(validateSelection(base, { variantId: "l", optionIds: ["green"] }, 1))).toEqual([]);
    expect(
      codes(
        validateSelection(
          { ...base, availability: "sold_out" },
          { variantId: "nope", optionIds: ["mint", "honey", "lemon", "green", "black"] },
          0,
        ),
      ),
    ).toEqual(
      [
        // Both groups are over: two leaves in "leaf", honey and lemon in "extras".
        "group_above_maximum",
        "group_above_maximum",
        "option_invalid",
        "option_unavailable",
        "product_unavailable",
        "quantity_invalid",
        "variant_invalid",
      ].sort(),
    );
    expect(codes(validateSelection(base, { variantId: "s", optionIds: [] }, 1))).toEqual(
      ["group_below_minimum", "variant_unavailable"].sort(),
    );
    expect(codes(validateSelection(base, { variantId: "l", optionIds: ["green"] }, 1.5))).toEqual([
      "quantity_invalid",
    ]);
  });
});
