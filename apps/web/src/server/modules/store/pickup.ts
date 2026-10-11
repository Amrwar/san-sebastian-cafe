import {
  and,
  asc,
  count,
  deliveryZones,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  openingHours,
  or,
  orders,
  storeClosures,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  computePickupAvailability,
  type PickupAvailability,
  type PickupSettings,
} from "@ssc/domain";

type Db = Database | Tx;

export interface StoreConfig {
  settings: PickupSettings & { autoAccept: boolean; unpaidTtlMinutes: number };
  hours: Array<{ weekday: number; opensAtMinute: number; closesAtMinute: number }>;
  closedDates: Set<string>;
  usesDemoHours: boolean;
}

/** Store settings, hours and closures. No settings row = online ordering not configured. */
export async function loadStoreConfig(db: Db): Promise<StoreConfig> {
  const [settings, hours, closures] = await Promise.all([
    db.query.storeSettings.findFirst(),
    db.select().from(openingHours).orderBy(asc(openingHours.weekday)),
    db.select({ localDate: storeClosures.localDate }).from(storeClosures),
  ]);
  return {
    settings: {
      onlineOrderingEnabled: settings?.onlineOrderingEnabled ?? false,
      prepMinutes: settings?.prepMinutes ?? 10,
      slotMinutes: settings?.slotMinutes ?? 15,
      daysAhead: settings?.daysAhead ?? 2,
      pausedUntil: settings?.pausedUntil ?? null,
      orderCutoffMinutes: settings?.orderCutoffMinutes ?? 15,
      minLeadMinutes: settings?.minLeadMinutes ?? 0,
      maxOrdersPerSlot: settings?.maxOrdersPerSlot ?? null,
      autoAccept: settings?.autoAccept ?? false,
      unpaidTtlMinutes: settings?.unpaidTtlMinutes ?? 15,
    },
    hours: hours.map((h) => ({
      weekday: h.weekday,
      opensAtMinute: h.opensAtMinute,
      closesAtMinute: h.closesAtMinute,
    })),
    closedDates: new Set(closures.map((c) => c.localDate)),
    usesDemoHours: Boolean(settings?.isDemo) || hours.some((h) => h.isDemo),
  };
}

/** Orders that occupy pickup capacity: live kitchen orders and unpaid orders not yet expired. */
export function holdsSlot(now: Date) {
  return or(
    inArray(orders.status, ["paid", "accepted", "in_preparation", "ready"]),
    and(
      eq(orders.status, "awaiting_payment"),
      or(isNull(orders.expiresAt), gt(orders.expiresAt, now)),
    ),
  );
}

/** Orders holding each slot from `from` onward, keyed by slot start (UTC ISO). */
export async function bookedSlotCounts(
  db: Db,
  from: Date,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ slotStart: orders.slotStart, n: count() })
    .from(orders)
    .where(and(gte(orders.slotStart, from), holdsSlot(now)))
    .groupBy(orders.slotStart);
  return new Map(
    rows.flatMap((r) => (r.slotStart ? [[r.slotStart.toISOString(), r.n] as const] : [])),
  );
}

export async function computeAvailability(
  db: Db,
  config: StoreConfig,
  now: Date,
): Promise<PickupAvailability> {
  const from = new Date(now.getTime() - config.settings.slotMinutes * 60_000);
  const booked = config.settings.maxOrdersPerSlot
    ? await bookedSlotCounts(db, from, now)
    : new Map<string, number>();
  return computePickupAvailability(
    config.hours,
    config.settings,
    now,
    undefined,
    config.closedDates,
    booked,
  );
}

export interface FulfilmentOptions {
  pickup: PickupAvailability;
  /** True only when at least one active delivery zone exists. */
  deliveryOffered: boolean;
  /** True when the hours/settings in use are development demo data. */
  usesDemoHours: boolean;
}

/** Pickup times from the café's configured hours, closures, preparation time and capacity. */
export async function getFulfilmentOptions(
  db: Database,
  now = new Date(),
): Promise<FulfilmentOptions> {
  const config = await loadStoreConfig(db);
  const [pickup, zones] = await Promise.all([
    computeAvailability(db, config, now),
    db
      .select({ id: deliveryZones.id })
      .from(deliveryZones)
      .where(eq(deliveryZones.isActive, true))
      .limit(1),
  ]);
  return { pickup, deliveryOffered: zones.length > 0, usesDemoHours: config.usesDemoHours };
}
