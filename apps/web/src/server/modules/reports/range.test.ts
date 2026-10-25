import { describe, expect, it } from "vitest";
import { cafeToday, eachDay, presetRange, reportRangeInput } from "./range";

describe("report ranges", () => {
  it("accepts real, ordered dates up to a year apart", () => {
    expect(reportRangeInput.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
    expect(reportRangeInput.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(
      false,
    );
    expect(reportRangeInput.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(
      false,
    );
    expect(reportRangeInput.safeParse({ from: "2025-10-01", to: "2026-10-01" }).success).toBe(true);
    expect(reportRangeInput.safeParse({ from: "2025-10-01", to: "2026-10-02" }).success).toBe(
      false,
    );
    expect(reportRangeInput.safeParse({ from: "10/01/2026", to: "2026-10-02" }).success).toBe(
      false,
    );
  });

  it("lists every day, across month ends and DST changes", () => {
    expect(eachDay({ from: "2026-10-30", to: "2026-11-02" })).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("uses the café's date, not UTC", () => {
    // 23:30 in Montréal is already the next day in UTC.
    expect(cafeToday(new Date("2026-10-13T03:30:00Z"))).toBe("2026-10-12");
  });

  it("computes presets", () => {
    expect(presetRange("yesterday", "2026-03-01")).toEqual({
      from: "2026-02-28",
      to: "2026-02-28",
    });
    expect(presetRange("last7", "2026-10-12")).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(presetRange("thisMonth", "2026-10-12")).toEqual({
      from: "2026-10-01",
      to: "2026-10-12",
    });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });
});
