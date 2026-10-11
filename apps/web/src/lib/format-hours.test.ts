import { describe, expect, it } from "vitest";
import { formatWindows } from "./format-hours";

const weekdayMornings = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 420,
  endMinute: 660,
}));

describe("formatWindows", () => {
  it("groups consecutive days with the same hours", () => {
    const en = formatWindows(weekdayMornings, "en").replace(/\s/g, " ");
    expect(en).toMatch(/^Mon–Fri 7:00 a\.m\.–11:00 a\.m\.$/);
    const fr = formatWindows(weekdayMornings, "fr").replace(/\s/g, " ");
    expect(fr).toMatch(/^lun\.–ven\. 7 h 00–11 h 00$/);
  });

  it("lists separate ranges", () => {
    const text = formatWindows(
      [{ weekday: 6, startMinute: 480, endMinute: 600 }, ...weekdayMornings.slice(0, 1)],
      "en",
    );
    expect(text.split(" · ")).toHaveLength(2);
  });
});
