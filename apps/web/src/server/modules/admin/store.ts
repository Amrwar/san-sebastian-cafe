import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lt,
  openingHours,
  orders,
  storeClosures,
  storeSettings,
  type Database,
} from "@ssc/db";
import { localParts, zonedToUtc } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";
import { loadStoreConfig, type StoreConfig } from "../store/pickup";

/*
 * Store configuration (manager and above): online ordering settings, weekly opening hours and
 * closures. Everything is audited. Saving replaces the development defaults (is_demo → false).
 * Orders already placed keep their pickup time; a closure only warns about them.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/** Statuses of orders that still have a pickup ahead of them. */
const UPCOMING = [
  "awaiting_payment",
  "paid",
  "accepted",
  "in_preparation",
  "ready",
  "out_for_delivery",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** The café's local calendar date (YYYY-MM-DD) at `instant`. */
export function localDate(instant: Date): string {
  const p = localParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC bounds of one local calendar day. */
function dayBounds(date: string): { start: Date; end: Date } {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const start = zonedToUtc(y, m, d, 0);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start,
    end: zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0),
  };
}

export interface StoreAdmin {
  settings: StoreConfig["settings"];
  hours: StoreConfig["hours"];
  closures: Array<{
    localDate: string;
    reasonFr: string | null;
    reasonEn: string | null;
    upcomingOrders: number;
  }>;
  usesDemoValues: boolean;
}

async function upcomingOrdersOn(db: Database, date: string): Promise<number> {
  const { start, end } = dayBounds(date);
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [...UPCOMING]),
        gte(orders.slotStart, start),
        lt(orders.slotStart, end),
      ),
    );
  return rows.length;
}

/** Current settings, hours and upcoming closures (with orders already booked on those days). */
export async function getStoreAdmin(
  db: Database,
  actor: Actor | null,
  now = new Date(),
): Promise<StoreAdmin> {
  authorize(actor, "store:configure");
  const [config, closures] = await Promise.all([
    loadStoreConfig(db),
    db
      .select()
      .from(storeClosures)
      .where(gte(storeClosures.localDate, localDate(now)))
      .orderBy(asc(storeClosures.localDate)),
  ]);
  return {
    settings: config.settings,
    hours: config.hours,
    closures: await Promise.all(
      closures.map(async (c) => ({
        localDate: c.localDate,
        reasonFr: c.reasonFr,
        reasonEn: c.reasonEn,
        upcomingOrders: await upcomingOrdersOn(db, c.localDate),
      })),
    ),
    usesDemoValues: config.usesDemoHours,
  };
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const storeSettingsInput = z
  .object({
    onlineOrderingEnabled: z.boolean(),
    prepMinutes: int(0, 240),
    slotMinutes: int(5, 120),
    daysAhead: int(0, 14),
    orderCutoffMinutes: int(0, 240),
    minLeadMinutes: int(0, 1440),
    maxOrdersPerSlot: int(1, 500).nullable(),
    autoAccept: z.boolean(),
    unpaidTtlMinutes: int(5, 120),
  })
  .strict();
export type StoreSettingsInput = z.infer<typeof storeSettingsInput>;

export async function saveStoreSettings(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<void> {
  authorize(actor, "store:configure");
  const input = parse(storeSettingsInput, raw);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(storeSettings).for("update");
    await tx
      .insert(storeSettings)
      .values({ id: 1, ...input, isDemo: false })
      .onConflictDoUpdate({ target: storeSettings.id, set: { ...input, isDemo: false } });
    const changed = before
      ? Object.fromEntries(
          (Object.keys(input) as Array<keyof StoreSettingsInput>)
            .filter((k) => before[k] !== input[k])
            .map((k) => [k, { from: before[k], to: input[k] }]),
        )
      : input;
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "store.settings_changed",
      entityType: "store_settings",
      metadata: { changed },
    });
  });
}

const hourInput = z
  .object({
    weekday: int(0, 6),
    opensAtMinute: int(0, 1439),
    closesAtMinute: int(1, 1440),
  })
  .strict()
  .refine((h) => h.opensAtMinute < h.closesAtMinute, {
    path: ["closesAtMinute"],
    message: "before opening",
  });

export const openingHoursInput = z
  .object({ hours: z.array(hourInput).max(28) })
  .strict()
  .superRefine(({ hours }, ctx) => {
    // Periods of one day may not overlap (a lunch break is two periods).
    for (let i = 0; i < hours.length; i++) {
      for (let j = i + 1; j < hours.length; j++) {
        const a = hours[i];
        const b = hours[j];
        if (
          a &&
          b &&
          a.weekday === b.weekday &&
          a.opensAtMinute < b.closesAtMinute &&
          b.opensAtMinute < a.closesAtMinute
        )
          ctx.addIssue({ code: "custom", path: ["hours", j], message: "overlap" });
      }
    }
  });

/** Replaces the weekly opening hours. A day with no period is closed. */
export async function saveOpeningHours(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<void> {
  authorize(actor, "store:configure");
  const { hours } = parse(openingHoursInput, raw);
  await db.transaction(async (tx) => {
    const before = await tx
      .select({
        weekday: openingHours.weekday,
        opensAtMinute: openingHours.opensAtMinute,
        closesAtMinute: openingHours.closesAtMinute,
      })
      .from(openingHours)
      .orderBy(asc(openingHours.weekday), asc(openingHours.opensAtMinute));
    await tx.delete(openingHours);
    if (hours.length > 0) await tx.insert(openingHours).values(hours);
    // A café that has set real hours no longer runs on demo settings either.
    await tx.update(storeSettings).set({ isDemo: false });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "store.hours_changed",
      entityType: "opening_hours",
      metadata: { from: before, to: hours },
    });
  });
}

export const closureInput = z
  .object({
    localDate: z.iso.date(),
    reasonFr: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => v || null),
    reasonEn: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => v || null),
  })
  .strict();

/**
 * Closes the café on a date (holiday, event). New orders can't be scheduled that day; orders
 * already booked are reported so staff can contact those customers.
 */
export async function addClosure(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<{ upcomingOrders: number }> {
  authorize(actor, "store:configure");
  const input = parse(closureInput, raw);
  if (input.localDate < localDate(now)) {
    throw new AppError("validation_failed", "Date in the past", [
      { path: "localDate", code: "past_date" },
    ]);
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(storeClosures)
      .values({ ...input, isDemo: false })
      .onConflictDoUpdate({
        target: storeClosures.localDate,
        set: { reasonFr: input.reasonFr, reasonEn: input.reasonEn, isDemo: false },
      });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "store.closure_added",
      entityType: "store_closure",
      entityId: input.localDate,
      metadata: { reasonFr: input.reasonFr, reasonEn: input.reasonEn },
    });
  });
  return { upcomingOrders: await upcomingOrdersOn(db, input.localDate) };
}

export async function removeClosure(
  db: Database,
  actor: Actor | null,
  date: string,
): Promise<void> {
  authorize(actor, "store:configure");
  if (!z.iso.date().safeParse(date).success) throw notFound("Closure");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(storeClosures)
      .where(eq(storeClosures.localDate, date))
      .returning({ localDate: storeClosures.localDate });
    if (!row) throw notFound("Closure");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "store.closure_removed",
      entityType: "store_closure",
      entityId: date,
    });
  });
}
