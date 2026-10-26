import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stockReturnsOn } from "../ordering/state-machine";
import { ORDER_STATUSES } from "../ordering/ordering";
import { computeQuote } from "../pricing/quote";
import { productAt } from "./availability";
import type { ConfiguredProduct } from "./configuration";
import { isOutOfStock, stockDemand, stockLevel, stockShortfalls, type StockLine } from "./stock";

/* Inventory: auto-86 at zero, cart-wide stock checks, and when an order gives its stock back. */

const croissant = (stock: number | null): ConfiguredProduct => ({
  id: "croissant",
  categoryId: "bakery",
  availability: "available",
  taxCategory: "standard",
  isDrink: false,
  loyaltyQualifying: false,
  rewardEligible: false,
  stock,
  variants: [{ id: "c", priceCents: 300, isDefault: true, availability: "available" }],
  groups: [],
});

const latte = (oatStock: number | null): ConfiguredProduct => ({
  id: "latte",
  categoryId: "drinks",
  availability: "available",
  taxCategory: "standard",
  isDrink: true,
  loyaltyQualifying: true,
  rewardEligible: true,
  variants: [{ id: "l", priceCents: 450, isDefault: true, availability: "available" }],
  groups: [
    {
      id: "milk",
      selection: "single",
      minSelected: 1,
      maxSelected: 1,
      options: [
        { id: "whole", priceDeltaCents: 0, isDefault: true, availability: "available" },
        {
          id: "oat",
          priceDeltaCents: 75,
          isDefault: false,
          availability: "available",
          stock: oatStock,
        },
      ],
    },
  ],
});

const now = new Date("2026-10-12T13:00:00Z");
const catalogOf = (...products: ConfiguredProduct[]) => new Map(products.map((p) => [p.id, p]));

describe("auto-86", () => {
  it("a tracked product or option at zero is sold out; untracked or in stock stays on sale", () => {
    expect(isOutOfStock({ stock: 0 })).toBe(true);
    expect(isOutOfStock({ stock: 1 })).toBe(false);
    expect(isOutOfStock({ stock: null })).toBe(false);
    expect(isOutOfStock({})).toBe(false);
    expect(productAt(croissant(0), now)).toMatchObject({
      availability: "sold_out",
      unavailableReason: "sold_out",
    });
    expect(productAt(croissant(3), now).availability).toBe("available");
    expect(productAt(latte(0), now).groups[0]?.options[1]?.availability).toBe("sold_out");
    expect(productAt(latte(null), now).groups[0]?.options[1]?.availability).toBe("available");
  });
});

describe("stock level", () => {
  it("is low at or under the item's alert threshold, out at zero, untracked without a count", () => {
    expect(stockLevel({ stock: null, lowStockThreshold: 3 })).toBe("untracked");
    expect(stockLevel({})).toBe("untracked");
    expect(stockLevel({ stock: 0, lowStockThreshold: 3 })).toBe("out");
    expect(stockLevel({ stock: 3, lowStockThreshold: 3 })).toBe("low");
    expect(stockLevel({ stock: 4, lowStockThreshold: 3 })).toBe("ok");
    // No threshold: never "low", still "out" at zero.
    expect(stockLevel({ stock: 1, lowStockThreshold: null })).toBe("ok");
    expect(stockLevel({ stock: 0 })).toBe("out");
  });
});

describe("stock across a cart", () => {
  it("counts each unit of a line against its product and every chosen option", () => {
    const demand = stockDemand([
      { productId: "latte", optionIds: ["oat", "oat"], quantity: 2 },
      { productId: "latte", optionIds: ["whole"], quantity: 1 },
    ]);
    expect(Object.fromEntries(demand.products)).toEqual({ latte: 3 });
    expect(Object.fromEntries(demand.options)).toEqual({ oat: 2, whole: 1 });
  });

  it("serves lines in order; a line that doesn't fit takes nothing and says what's left", () => {
    const catalog = catalogOf(croissant(3));
    const lines = [2, 2, 1].map((quantity) => ({
      productId: "croissant",
      optionIds: [],
      quantity,
    }));
    expect(stockShortfalls(lines, catalog)).toEqual([
      [],
      [{ code: "insufficient_stock", ref: "croissant", available: 1 }],
      [],
    ]);
  });

  it("refuses an over-stock line in the quote, without charging for it", () => {
    const quote = computeQuote({
      lines: [
        { lineId: "a", productId: "latte", variantId: "l", optionIds: ["oat"], quantity: 3 },
        { lineId: "b", productId: "croissant", variantId: "c", optionIds: [], quantity: 1 },
      ],
      catalog: catalogOf(latte(2), croissant(null)),
      fulfilment: { method: "pickup" },
      tip: { kind: "none" },
      now,
    });
    expect(quote.lines[0]).toMatchObject({
      valid: false,
      lineTotalCents: 0,
      issues: [{ code: "insufficient_stock", ref: "oat", available: 2 }],
    });
    expect(quote.lines[1]?.valid).toBe(true);
    expect(quote.subtotalCents).toBe(300);
    expect(quote.canCheckout).toBe(false);
  });

  it("never serves more than is left of any item (properties)", () => {
    const line = fc.record({
      productId: fc.constantFrom("croissant", "latte"),
      optionIds: fc.subarray(["whole", "oat"], { maxLength: 1 }),
      quantity: fc.integer({ min: 0, max: 6 }),
    });
    const stock = fc.option(fc.integer({ min: 0, max: 10 }), { nil: null });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), stock, stock, (lines, croissants, oat) => {
        const catalog = catalogOf(croissant(croissants), latte(oat));
        const shortfalls = stockShortfalls(lines, catalog);
        const served: StockLine[] = lines.filter((_, i) => shortfalls[i]?.length === 0);
        const used = stockDemand(served);
        if (croissants !== null)
          expect(used.products.get("croissant") ?? 0).toBeLessThanOrEqual(croissants);
        if (oat !== null) expect(used.options.get("oat") ?? 0).toBeLessThanOrEqual(oat);
        // A refused line really didn't fit what the earlier served lines left.
        lines.forEach((l, i) => {
          for (const issue of shortfalls[i] ?? [])
            expect(l.quantity).toBeGreaterThan(issue.available ?? 0);
        });
        // Nothing tracked: nothing refused.
        if (croissants === null && oat === null) expect(shortfalls.flat()).toEqual([]);
      }),
    );
  });
});

describe("stock returned by a status change", () => {
  it("comes back when an order expires, or is cancelled or rejected before preparation", () => {
    expect(stockReturnsOn("awaiting_payment", "expired")).toBe(true);
    expect(stockReturnsOn("awaiting_payment", "cancelled")).toBe(true);
    expect(stockReturnsOn("paid", "rejected")).toBe(true);
    expect(stockReturnsOn("accepted", "cancelled")).toBe(true);
    // Being made or made: the ingredients are used.
    expect(stockReturnsOn("in_preparation", "cancelled")).toBe(false);
    expect(stockReturnsOn("ready", "cancelled")).toBe(false);
    expect(stockReturnsOn("completed", "refunded")).toBe(false);
    // Only stopping an order returns stock.
    for (const from of ORDER_STATUSES)
      for (const to of ["paid", "accepted", "in_preparation", "ready", "completed"] as const)
        expect(stockReturnsOn(from, to)).toBe(false);
  });
});
