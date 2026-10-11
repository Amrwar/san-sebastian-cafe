/**
 * Pickup scheduling in the café's local time zone (America/Toronto for Montréal), DST-safe.
 * Opening hours are owner data; until supplied, development seed hours are used (labelled demo).
 * Capacity: `booked` counts are supplied by the caller (orders already holding each slot); the
 * order-placement transaction re-checks them under a lock so two customers can't take the last spot.
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
  /** Staff "pause online ordering" until this instant (rush, equipment failure…). */
  pausedUntil?: Date | null;
  /** Last orders this many minutes before closing (ASAP and slots). Default 0. */
  orderCutoffMinutes?: number;
  /** Scheduled orders must be at least this far ahead (≥ prepMinutes). Default = prepMinutes. */
  minLeadMinutes?: number;
  /** Maximum orders per slot; null/undefined = unlimited. */
  maxOrdersPerSlot?: number | null;
}

export interface PickupSlot {
  /** UTC instant, ISO string. */
  startsAt: string;
  /** Local calendar date (YYYY-MM-DD) the slot belongs to. */
  localDate: string;
  /** Orders still accepted in this slot; null = unlimited. Full slots are not listed. */
  remaining: number | null;
}

export interface PickupAvailability {
  /** True when an "as soon as possible" order can be ready before closing today. */
  asapAvailable: boolean;
  /** Earliest ready time for ASAP orders (UTC ISO), if available. */
  asapReadyAt: string | null;
  /** Why ASAP isn't possible right now (null when it is, or when ordering is unavailable). */
  asapUnavailableReason: "closed" | "busy" | null;
  slots: PickupSlot[];
  /** Why ordering is unavailable right now, if it is. */
  reason: "ordering_disabled" | "paused" | "no_hours_configured" | null;
  /** End of a staff pause (UTC ISO), when paused. */
  pausedUntil: string | null;
}

/** Start of the capacity slot that contains `instant` (slots are aligned to UTC epoch multiples). */
export function slotStartFor(instant: Date, slotMinutes: number): Date {
  const slotMs = slotMinutes * 60_000;
  return new Date(Math.floor(instant.getTime() / slotMs) * slotMs);
}

export type PickupRequest = { kind: "asap" } | { kind: "scheduled"; at: Date };

export type PickupCheck =
  | { ok: true; readyAt: Date; slotStart: Date; scheduledFor: Date | null }
  | { ok: false; error: "ordering_unavailable" | "asap_unavailable" | "slot_unavailable" };

/** Validates a requested pickup against freshly computed availability. */
export function checkPickupRequest(
  availability: PickupAvailability,
  request: PickupRequest,
  slotMinutes: number,
): PickupCheck {
  if (availability.reason) return { ok: false, error: "ordering_unavailable" };
  if (request.kind === "asap") {
    if (!availability.asapAvailable || !availability.asapReadyAt)
      return { ok: false, error: "asap_unavailable" };
    const readyAt = new Date(availability.asapReadyAt);
    return { ok: true, readyAt, slotStart: slotStartFor(readyAt, slotMinutes), scheduledFor: null };
  }
  const iso = request.at.toISOString();
  const slot = availability.slots.find((s) => s.startsAt === iso);
  if (!slot) return { ok: false, error: "slot_unavailable" };
  return { ok: true, readyAt: request.at, slotStart: request.at, scheduledFor: request.at };
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
  /** Orders already holding each slot, keyed by slot start (UTC ISO). */
  booked: ReadonlyMap<string, number> = new Map(),
): PickupAvailability {
  const unavailable = (reason: PickupAvailability["reason"]): PickupAvailability => ({
    asapAvailable: false,
    asapReadyAt: null,
    asapUnavailableReason: null,
    slots: [],
    reason,
    pausedUntil:
      reason === "paused" && settings.pausedUntil ? settings.pausedUntil.toISOString() : null,
  });
  if (!settings.onlineOrderingEnabled) return unavailable("ordering_disabled");
  if (hours.length === 0) return unavailable("no_hours_configured");
  if (settings.pausedUntil && settings.pausedUntil > now) return unavailable("paused");

  const earliest = now.getTime() + settings.prepMinutes * 60_000;
  const earliestScheduled =
    now.getTime() + Math.max(settings.prepMinutes, settings.minLeadMinutes ?? 0) * 60_000;
  const cutoffMs = (settings.orderCutoffMinutes ?? 0) * 60_000;
  const slotMs = settings.slotMinutes * 60_000;
  const capacity = settings.maxOrdersPerSlot ?? null;
  const remainingIn = (startIso: string) =>
    capacity === null ? null : Math.max(0, capacity - (booked.get(startIso) ?? 0));
  const today = localParts(now, timeZone);
  const slots: PickupSlot[] = [];
  let asapReadyAt: string | null = null;
  let asapUnavailableReason: PickupAvailability["asapUnavailableReason"] = "closed";

  for (let offset = 0; offset <= settings.daysAhead; offset++) {
    // Calendar arithmetic at local noon avoids DST edge effects when stepping days.
    const noon = zonedToUtc(today.year, today.month, today.day + offset, 12 * 60, timeZone);
    const d = localParts(noon, timeZone);
    const localDate = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
    if (closedDates.has(localDate)) continue;

    for (const range of hours.filter((h) => h.weekday === d.weekday)) {
      const open = zonedToUtc(d.year, d.month, d.day, range.opensAtMinute, timeZone).getTime();
      const close = zonedToUtc(d.year, d.month, d.day, range.closesAtMinute, timeZone).getTime();
      const lastOrder = close - cutoffMs;
      if (
        offset === 0 &&
        asapReadyAt === null &&
        now.getTime() >= open &&
        now.getTime() <= lastOrder &&
        earliest <= close
      ) {
        const slot = slotStartFor(new Date(earliest), settings.slotMinutes).toISOString();
        if (remainingIn(slot) === 0) asapUnavailableReason = "busy";
        else {
          asapReadyAt = new Date(earliest).toISOString();
          asapUnavailableReason = null;
        }
      }
      // Slots start once the lead time has passed, before the cutoff, and end before closing.
      for (
        let t = Math.max(open, Math.ceil(earliestScheduled / slotMs) * slotMs);
        t <= Math.min(close - slotMs, lastOrder);
        t += slotMs
      ) {
        if (t < earliestScheduled) continue;
        const startsAt = new Date(t).toISOString();
        const remaining = remainingIn(startsAt);
        if (remaining !== 0) slots.push({ startsAt, localDate, remaining });
      }
    }
  }

  return {
    asapAvailable: asapReadyAt !== null,
    asapReadyAt,
    asapUnavailableReason: asapReadyAt !== null ? null : asapUnavailableReason,
    slots,
    reason: null,
    pausedUntil: null,
  };
}
