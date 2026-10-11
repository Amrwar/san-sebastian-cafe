/**
 * Pickup scheduling in the café's local time zone (America/Toronto for Montréal), DST-safe.
 * Opening hours are owner data; until supplied, development seed hours are used (labelled demo).
 * Slot capacity (orders per slot) is enforced at order placement (Phase 6), not here.
 */
export const CAFE_TIME_ZONE = "America/Toronto";

export interface OpeningRange {
  /** 0 = Sunday … 6 = Saturday (local). */
  weekday: number;
  /** Minutes after local midnight. */
  opensAtMinute: number;
  closesAtMinute: number;
}

export interface PickupSettings {
  onlineOrderingEnabled: boolean;
  prepMinutes: number;
  slotMinutes: number;
  daysAhead: number;
}

export interface PickupSlot {
  /** UTC instant, ISO string. */
  startsAt: string;
  /** Local calendar date (YYYY-MM-DD) the slot belongs to. */
  localDate: string;
}

export interface PickupAvailability {
  /** True when an "as soon as possible" order can be ready before closing today. */
  asapAvailable: boolean;
  /** Earliest ready time for ASAP orders (UTC ISO), if available. */
  asapReadyAt: string | null;
  slots: PickupSlot[];
  /** Why ordering is unavailable right now, if it is. */
  reason: "ordering_disabled" | "no_hours_configured" | null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
}

export function localParts(instant: Date, timeZone = CAFE_TIME_ZONE): LocalParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** Offset (minutes) of `timeZone` from UTC at `instant`. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000);
}

/** Converts a local wall-clock time to a UTC instant (handles DST changes). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone = CAFE_TIME_ZONE,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  let instant = new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60_000);
  // Second pass corrects guesses that crossed a DST boundary.
  instant = new Date(guess - offsetMinutes(instant, timeZone) * 60_000);
  return instant;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function computePickupAvailability(
  hours: OpeningRange[],
  settings: PickupSettings,
  now: Date,
  timeZone = CAFE_TIME_ZONE,
  closedDates: ReadonlySet<string> = new Set(),
): PickupAvailability {
  if (!settings.onlineOrderingEnabled) {
    return { asapAvailable: false, asapReadyAt: null, slots: [], reason: "ordering_disabled" };
  }
  if (hours.length === 0) {
    return { asapAvailable: false, asapReadyAt: null, slots: [], reason: "no_hours_configured" };
  }

  const earliest = now.getTime() + settings.prepMinutes * 60_000;
  const slotMs = settings.slotMinutes * 60_000;
  const today = localParts(now, timeZone);
  const slots: PickupSlot[] = [];
  let asapReadyAt: string | null = null;

  for (let offset = 0; offset <= settings.daysAhead; offset++) {
    // Calendar arithmetic at local noon avoids DST edge effects when stepping days.
    const noon = zonedToUtc(today.year, today.month, today.day + offset, 12 * 60, timeZone);
    const d = localParts(noon, timeZone);
    const localDate = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
    if (closedDates.has(localDate)) continue;

    for (const range of hours.filter((h) => h.weekday === d.weekday)) {
      const open = zonedToUtc(d.year, d.month, d.day, range.opensAtMinute, timeZone).getTime();
      const close = zonedToUtc(d.year, d.month, d.day, range.closesAtMinute, timeZone).getTime();
      if (offset === 0 && now.getTime() >= open && earliest <= close && asapReadyAt === null) {
        asapReadyAt = new Date(earliest).toISOString();
      }
      // Slots start once preparation is possible and must be ready before closing.
      for (
        let t = Math.max(open, Math.ceil(earliest / slotMs) * slotMs);
        t <= close - slotMs;
        t += slotMs
      ) {
        if (t >= earliest) slots.push({ startsAt: new Date(t).toISOString(), localDate });
      }
    }
  }

  return { asapAvailable: asapReadyAt !== null, asapReadyAt, slots, reason: null };
}
