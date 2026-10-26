import { CAFE_TIME_ZONE, localParts } from "../ordering/pickup";
import type { Availability } from "./catalog";
import type { AvailabilityWindow, ConfiguredProduct } from "./configuration";
import { isOutOfStock } from "./stock";

export type UnavailableReason = "sold_out" | "temporarily_unavailable" | "outside_hours" | "hidden";

/** True when `at` (local time) falls inside one of the windows; no windows = always. */
export function withinWindows(
  windows: readonly AvailabilityWindow[] | undefined,
  at: Date,
  timeZone = CAFE_TIME_ZONE,
): boolean {
  if (!windows || windows.length === 0) return true;
  const p = localParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  return windows.some(
    (w) => w.weekday === p.weekday && minute >= w.startMinute && minute < w.endMinute,
  );
}

/** Why a product can't be ordered at `at`, or null when it can. */
export function unavailableReason(product: ConfiguredProduct, at: Date): UnavailableReason | null {
  if (product.availability === "hidden") return "hidden";
  if (product.availability === "sold_out" || isOutOfStock(product)) return "sold_out";
  if (product.unavailableUntil && product.unavailableUntil > at) return "temporarily_unavailable";
  if (!withinWindows(product.availabilityWindows, at)) return "outside_hours";
  return null;
}

/**
 * The product as it can be ordered at `at`: schedule windows and temporary disabling are folded
 * into `availability` for the product and its options, so pricing and the UI share one answer.
 * `at` is the moment the order will be prepared (pickup time), not necessarily "now".
 */
export function productAt<P extends ConfiguredProduct>(
  product: P,
  at: Date,
): P & { unavailableReason: UnavailableReason | null } {
  const reason = unavailableReason(product, at);
  const effective: Availability =
    reason === null ? "available" : reason === "hidden" ? "hidden" : "sold_out";
  return {
    ...product,
    availability: effective,
    unavailableReason: reason,
    groups: product.groups.map((g) => ({
      ...g,
      options: g.options.map((o) => ({
        ...o,
        availability:
          o.availability === "available" &&
          ((o.unavailableUntil && o.unavailableUntil > at) || isOutOfStock(o))
            ? "sold_out"
            : o.availability,
      })),
    })),
  };
}

export function catalogAt<P extends ConfiguredProduct>(
  catalog: ReadonlyMap<string, P>,
  at: Date,
): Map<string, P & { unavailableReason: UnavailableReason | null }> {
  return new Map([...catalog].map(([id, p]) => [id, productAt(p, at)]));
}
