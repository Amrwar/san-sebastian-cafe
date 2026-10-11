import { describe, expect, it } from "vitest";
import {
  checkPickupRequest,
  computePickupAvailability,
  localParts,
  type OpeningRange,
  slotStartFor,
  zonedToUtc,
} from "./pickup";

// Every day 07:00–18:00 local.
const hours: OpeningRange[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opensAtMinute: 7 * 60,
  closesAtMinute: 18 * 60,
}));
const settings = { onlineOrderingEnabled: true, prepMinutes: 10, slotMinutes: 15, daysAhead: 1 };

describe("zonedToUtc", () => {
  it("converts Montréal wall-clock time in summer (EDT, UTC−4) and winter (EST, UTC−5)", () => {
    expect(zonedToUtc(2026, 7, 1, 9 * 60).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedToUtc(2026, 12, 1, 9 * 60).toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("is correct on DST transition days", () => {
    expect(zonedToUtc(2026, 3, 8, 9 * 60).toISOString()).toBe("2026-03-08T13:00:00.000Z"); // spring forward
    expect(zonedToUtc(2026, 11, 1, 9 * 60).toISOString()).toBe("2026-11-01T14:00:00.000Z"); // fall back
  });
});

describe("computePickupAvailability", () => {
  it("offers ASAP and aligned slots after the preparation time while open", () => {
    const now = new Date("2026-10-11T13:02:00Z"); // 09:02 EDT
    const a = computePickupAvailability(hours, settings, now);
    expect(a.asapAvailable).toBe(true);
    expect(a.asapReadyAt).toBe("2026-10-11T13:12:00.000Z");
    expect(a.slots[0]?.startsAt).toBe("2026-10-11T13:15:00.000Z");
    // Last slot of the day must start at least one slot before closing (18:00 → 17:45 EDT).
    const todays = a.slots.filter((s) => s.localDate === "2026-10-11");
    expect(todays.at(-1)?.startsAt).toBe("2026-10-11T21:45:00.000Z");
    expect(a.slots.some((s) => s.localDate === "2026-10-12")).toBe(true);
  });

  it("offers no ASAP before opening or near closing, but still offers future slots", () => {
    const early = computePickupAvailability(hours, settings, new Date("2026-10-11T09:00:00Z")); // 05:00
    expect(early.asapAvailable).toBe(false);
    expect(early.slots[0]?.startsAt).toBe("2026-10-11T11:00:00.000Z"); // 07:00 EDT
    const late = computePickupAvailability(hours, settings, new Date("2026-10-11T21:55:00Z")); // 17:55
    expect(late.asapAvailable).toBe(false);
    expect(late.slots[0]?.localDate).toBe("2026-10-12");
  });

  it("skips closed dates and reports disabled ordering or missing hours", () => {
    const now = new Date("2026-10-11T13:00:00Z");
    const closed = computePickupAvailability(
      hours,
      settings,
      now,
      undefined,
      new Set(["2026-10-11"]),
    );
    expect(closed.slots.every((s) => s.localDate === "2026-10-12")).toBe(true);
    expect(
      computePickupAvailability(hours, { ...settings, onlineOrderingEnabled: false }, now).reason,
    ).toBe("ordering_disabled");
    expect(computePickupAvailability([], settings, now).reason).toBe("no_hours_configured");
  });

  it("reads local weekday correctly", () => {
    expect(localParts(new Date("2026-10-12T03:00:00Z")).weekday).toBe(0); // still Sunday 23:00 EDT
  });
});

describe("capacity, cutoff, pause and lead time", () => {
  const now = new Date("2026-10-11T13:02:00Z"); // 09:02 EDT, ready ~09:12
  const base = { ...settings, slotMinutes: 15, prepMinutes: 10 };

  it("hides full slots and reports remaining capacity", () => {
    const booked = new Map([["2026-10-11T13:30:00.000Z", 2]]);
    const a = computePickupAvailability(
      hours,
      { ...base, maxOrdersPerSlot: 2 },
      now,
      undefined,
      new Set(),
      booked,
    );
    expect(a.slots.some((s) => s.startsAt === "2026-10-11T13:30:00.000Z")).toBe(false);
    expect(a.slots[0]).toMatchObject({ startsAt: "2026-10-11T13:15:00.000Z", remaining: 2 });
  });

  it("refuses ASAP when the slot it would land in is full", () => {
    const booked = new Map([["2026-10-11T13:00:00.000Z", 3]]); // ready 09:12 → slot 09:00
    const a = computePickupAvailability(
      hours,
      { ...base, maxOrdersPerSlot: 3 },
      now,
      undefined,
      new Set(),
      booked,
    );
    expect(a.asapAvailable).toBe(false);
    expect(a.asapUnavailableReason).toBe("busy");
    expect(checkPickupRequest(a, { kind: "asap" }, 15)).toEqual({
      ok: false,
      error: "asap_unavailable",
    });
  });

  it("stops taking orders at the cutoff before closing", () => {
    const late = new Date("2026-10-11T21:35:00Z"); // 17:35, closes 18:00, cutoff 30 min
    const a = computePickupAvailability(hours, { ...base, orderCutoffMinutes: 30 }, late);
    expect(a.asapAvailable).toBe(false);
    expect(a.slots.every((s) => s.localDate === "2026-10-12")).toBe(true);
  });

  it("applies a minimum lead time to scheduled orders", () => {
    const a = computePickupAvailability(hours, { ...base, minLeadMinutes: 60 }, now);
    expect(a.slots[0]?.startsAt).toBe("2026-10-11T14:15:00.000Z"); // ≥ 10:02 → 10:15
    expect(a.asapAvailable).toBe(true); // ASAP still uses the preparation time
  });

  it("pauses all ordering until the pause ends", () => {
    const pausedUntil = new Date("2026-10-11T13:30:00Z");
    expect(computePickupAvailability(hours, { ...base, pausedUntil }, now)).toMatchObject({
      reason: "paused",
      pausedUntil: "2026-10-11T13:30:00.000Z",
      slots: [],
    });
    expect(
      computePickupAvailability(hours, { ...base, pausedUntil }, new Date("2026-10-11T13:31:00Z"))
        .reason,
    ).toBeNull();
  });

  it("accepts only slots that are currently offered", () => {
    const a = computePickupAvailability(hours, base, now);
    expect(
      checkPickupRequest(a, { kind: "scheduled", at: new Date("2026-10-11T13:15:00Z") }, 15),
    ).toMatchObject({ ok: true });
    expect(
      checkPickupRequest(a, { kind: "scheduled", at: new Date("2026-10-11T13:17:00Z") }, 15),
    ).toEqual({
      ok: false,
      error: "slot_unavailable",
    });
    expect(slotStartFor(new Date("2026-10-11T13:12:00Z"), 15).toISOString()).toBe(
      "2026-10-11T13:00:00.000Z",
    );
  });
});
