import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeTaxes, isTaxable, rateOn, type TaxRate } from "../pricing/tax";
import { addCents, applyRatePpm, cents, multiplyCents, PPM } from "./money";

/*
 * Property tests: money math checked against an exact reference (BigInt) over thousands of random
 * amounts and rates, instead of a handful of hand-picked examples.
 */

/** Exact half-up (away from zero) rounding of value × rate / 1 000 000, in BigInt. */
function reference(value: number, ratePpm: number): number {
  const n = BigInt(value) * BigInt(ratePpm);
  const abs = n < 0n ? -n : n;
  const rounded = (abs + BigInt(PPM / 2)) / BigInt(PPM);
  return Number(n < 0n ? -rounded : rounded);
}

const amount = fc.integer({ min: -1_000_000_00, max: 1_000_000_00 });
const rate = fc.integer({ min: 0, max: 1_000_000 });

describe("applyRatePpm", () => {
  it("equals exact half-up rounding for any amount and rate", () => {
    fc.assert(
      fc.property(amount, rate, (v, r) => {
        expect(applyRatePpm(cents(v), r)).toBe(reference(v, r));
      }),
      { numRuns: 5000 },
    );
  });

  it("is symmetric around zero and never moves away from the exact value by more than half a cent", () => {
    fc.assert(
      fc.property(amount, rate, (v, r) => {
        expect(applyRatePpm(cents(-v), r)).toBe(0 - applyRatePpm(cents(v), r));
        expect(Math.abs(applyRatePpm(cents(v), r) - (v * r) / PPM)).toBeLessThanOrEqual(0.5);
      }),
    );
  });

  it("never decreases when the amount grows", () => {
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.nat(10_000), rate, (v, extra, r) => {
        expect(applyRatePpm(cents(v + extra), r)).toBeGreaterThanOrEqual(applyRatePpm(cents(v), r));
      }),
    );
  });

  it("refuses negative or fractional rates and amounts too large for exact math", () => {
    expect(() => applyRatePpm(cents(100), -1)).toThrow(RangeError);
    expect(() => applyRatePpm(cents(100), 0.5)).toThrow(RangeError);
    expect(() => applyRatePpm(cents(Number.MAX_SAFE_INTEGER), 999_999)).toThrow(RangeError);
  });
});

describe("cents arithmetic", () => {
  it("rejects anything but whole cents", () => {
    fc.assert(
      fc.property(fc.double({ noInteger: true, noNaN: true }), (v) => {
        expect(() => cents(v)).toThrow(RangeError);
      }),
    );
    expect(() => multiplyCents(cents(100), 1.5)).toThrow(RangeError);
  });

  it("adds and multiplies exactly", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -100_000, max: 100_000 })), (vs) => {
        expect(addCents(...vs.map((v) => cents(v)))).toBe(vs.reduce((s, v) => s + v, 0));
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 50 }), (v, q) => {
        expect(multiplyCents(cents(v), q)).toBe(v * q);
      }),
    );
  });
});

describe("Québec taxes", () => {
  it("are GST 5 % and QST 9.975 % of the base, each rounded half-up, never on a negative base", () => {
    const at = new Date("2026-10-12T12:00:00Z");
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 10_000_000 }), (base) => {
        const t = computeTaxes(base, at);
        const b = Math.max(0, base);
        expect(t).toEqual({
          gstCents: reference(b, 50_000),
          qstCents: reference(b, 99_750),
          gstRatePpm: 50_000,
          qstRatePpm: 99_750,
        });
      }),
    );
  });

  it("use the rate in effect on the day, and refuse a day before any rate", () => {
    const rates: TaxRate[] = [
      { code: "GST", ratePpm: 70_000, effectiveFrom: "2000-01-01" },
      { code: "GST", ratePpm: 50_000, effectiveFrom: "2008-01-01" },
    ];
    expect(rateOn("GST", new Date("2007-12-31T12:00:00Z"), rates)).toBe(70_000);
    expect(rateOn("GST", new Date("2008-01-01T12:00:00Z"), rates)).toBe(50_000);
    expect(() => rateOn("QST", new Date("2026-01-01T12:00:00Z"), rates)).toThrow(/No QST rate/);
    expect(() => rateOn("GST", new Date("1999-06-01T12:00:00Z"), rates)).toThrow(/No GST rate/);
  });

  it("apply to standard items only", () => {
    expect(isTaxable("standard")).toBe(true);
    expect(isTaxable("zero_rated")).toBe(false);
    expect(isTaxable("exempt")).toBe(false);
  });
});
