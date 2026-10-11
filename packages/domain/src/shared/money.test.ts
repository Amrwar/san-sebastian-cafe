import { describe, expect, it } from "vitest";
import { addCents, applyRatePpm, cents, formatCad, multiplyCents } from "./money";

describe("money", () => {
  it("rejects non-integer amounts", () => {
    expect(() => cents(4.5)).toThrow(RangeError);
    expect(() => cents(Number.NaN)).toThrow(RangeError);
  });

  it("adds and multiplies in integer cents", () => {
    expect(addCents(cents(450), cents(75), cents(1))).toBe(526);
    expect(multiplyCents(cents(525), 3)).toBe(1575);
  });

  it("applies ppm rates with half-up rounding", () => {
    expect(applyRatePpm(cents(1000), 50_000)).toBe(50); // GST 5%
    expect(applyRatePpm(cents(1000), 99_750)).toBe(100); // QST 9.975% → 99.75 → 100
    expect(applyRatePpm(cents(401), 99_750)).toBe(40); // 39.99975 → 40
    expect(applyRatePpm(cents(450), 99_750)).toBe(45); // 44.8875 → 45
    expect(applyRatePpm(cents(10), 500_000)).toBe(5);
    expect(applyRatePpm(cents(1), 500_000)).toBe(1); // 0.5 → 1 (half-up)
    expect(applyRatePpm(cents(-1), 500_000)).toBe(-1); // symmetric for refunds
    expect(() => applyRatePpm(cents(100), 0.5)).toThrow(RangeError);
  });

  it("formats CAD per Canadian locale", () => {
    // Intl may use narrow/non-breaking spaces; normalise for comparison.
    const norm = (s: string) => s.replace(/\s/g, " ");
    expect(norm(formatCad(cents(450), "fr-CA"))).toBe("4,50 $");
    expect(formatCad(cents(450), "en-CA")).toBe("$4.50");
  });
});
