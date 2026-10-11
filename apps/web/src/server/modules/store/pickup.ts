import { asc, deliveryZones, eq, openingHours, storeClosures, type Database } from "@ssc/db";
import { computePickupAvailability, type PickupAvailability } from "@ssc/domain";

export interface FulfilmentOptions {
  pickup: PickupAvailability;
  /** True only when at least one active delivery zone exists. */
  deliveryOffered: boolean;
  /** True when the hours/settings in use are development demo data. */
  usesDemoHours: boolean;
}

/** Pickup times from the café's configured hours, closures and preparation time. */
export async function getFulfilmentOptions(
  db: Database,
  now = new Date(),
): Promise<FulfilmentOptions> {
  const [settings, hours, closures, zones] = await Promise.all([
    db.query.storeSettings.findFirst(),
    db.select().from(openingHours).orderBy(asc(openingHours.weekday)),
    db.select({ localDate: storeClosures.localDate }).from(storeClosures),
    db
      .select({ id: deliveryZones.id })
      .from(deliveryZones)
      .where(eq(deliveryZones.isActive, true))
      .limit(1),
  ]);

  const pickup = computePickupAvailability(
    hours.map((h) => ({
      weekday: h.weekday,
      opensAtMinute: h.opensAtMinute,
      closesAtMinute: h.closesAtMinute,
    })),
    {
      // No settings row means the owner has not configured online ordering yet.
      onlineOrderingEnabled: settings?.onlineOrderingEnabled ?? false,
      prepMinutes: settings?.prepMinutes ?? 10,
      slotMinutes: settings?.slotMinutes ?? 15,
      daysAhead: settings?.daysAhead ?? 2,
    },
    now,
    undefined,
    new Set(closures.map((c) => c.localDate)),
  );

  return {
    pickup,
    deliveryOffered: zones.length > 0,
    usesDemoHours: Boolean(settings?.isDemo) || hours.some((h) => h.isDemo),
  };
}
