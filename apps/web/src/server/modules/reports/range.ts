import { CAFE_TIME_ZONE, localParts } from "@ssc/domain";
import { z } from "zod";

/*
 * Report periods are inclusive ranges of local dates in the café's time zone (America/Toronto).
 * The database turns them into instants itself, so DST days are 23 or 25 hours long, as they are.
 */

export const REPORT_TIME_ZONE = CAFE_TIME_ZONE;
/** At most about a year per report (and per export). */
export const MAX_REPORT_DAYS = 366;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => toUtcDay(v) !== null, { message: "invalid date" });

export const reportRangeInput = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "before start" })
  .refine((r) => dayCount(r.from, r.to) <= MAX_REPORT_DAYS, { path: ["to"], message: "too long" });
export type ReportRange = z.infer<typeof reportRangeInput>;

/** Midnight UTC of a YYYY-MM-DD date (NaN if malformed; JavaScript rolls 02-30 over to March). */
function utcDay(date: string): number {
  const [y = NaN, m = NaN, d = NaN] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Midnight UTC of a YYYY-MM-DD date, or null if the date doesn't exist. */
function toUtcDay(date: string): number | null {
  const t = utcDay(date);
  return Number.isNaN(t) || fromUtcDay(t) !== date ? null : t;
}

const fromUtcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

export function addDays(date: string, days: number): string {
  return fromUtcDay(utcDay(date) + days * DAY);
}

export function dayCount(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY) + 1;
}

/** Every date of the range, in order. */
export function eachDay(range: ReportRange): string[] {
  return Array.from({ length: dayCount(range.from, range.to) }, (_, i) => addDays(range.from, i));
}

/** Today's date at the café. */
export function cafeToday(now = new Date()): string {
  const p = localParts(now, REPORT_TIME_ZONE);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const REPORT_PRESETS = ["today", "yesterday", "last7", "thisMonth", "lastMonth"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

/** Common periods, relative to the café's today. Weeks and months end today at the latest. */
export function presetRange(preset: ReportPreset, today: string): ReportRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "thisMonth":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}
