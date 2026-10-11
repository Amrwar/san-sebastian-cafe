import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { productVariants, products } from "./catalog";
import { demoFlag, timestamps } from "./columns";
import { users } from "./identity";

/*
 * Store module: operating configuration. Opening hours are owner-supplied; until then the
 * development seed inserts demo hours (is_demo) so pickup scheduling can be exercised.
 */

/** Single-row settings table (id is always 1). */
export const storeSettings = pgTable(
  "store_settings",
  {
    id: smallint().primaryKey().default(1),
    onlineOrderingEnabled: boolean().notNull().default(false),
    prepMinutes: integer().notNull().default(10),
    slotMinutes: integer().notNull().default(15),
    daysAhead: integer().notNull().default(2),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    check("store_settings_singleton", sql`${t.id} = 1`),
    check(
      "store_settings_ranges",
      sql`${t.prepMinutes} between 0 and 240 and ${t.slotMinutes} between 5 and 120 and ${t.daysAhead} between 0 and 14`,
    ),
  ],
);

export const openingHours = pgTable(
  "opening_hours",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** 0 = Sunday … 6 = Saturday, local time (America/Toronto). */
    weekday: smallint().notNull(),
    opensAtMinute: integer().notNull(),
    closesAtMinute: integer().notNull(),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    index("opening_hours_weekday_idx").on(t.weekday),
    check(
      "opening_hours_range",
      sql`${t.weekday} between 0 and 6 and ${t.opensAtMinute} >= 0 and ${t.closesAtMinute} <= 1440 and ${t.opensAtMinute} < ${t.closesAtMinute}`,
    ),
  ],
);

export const storeClosures = pgTable("store_closures", {
  localDate: date().primaryKey(),
  reasonFr: text(),
  reasonEn: text(),
  ...demoFlag,
  ...timestamps,
});

/**
 * Saved drink configurations. option_ids are stored sorted so the same configuration can't be
 * saved twice. Owner: engagement (customer module).
 */
export const favorites = pgTable(
  "favorites",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    optionIds: uuid()
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("favorites_user_configuration_uq").on(
      t.userId,
      t.productId,
      t.variantId,
      t.optionIds,
    ),
    index("favorites_user_idx").on(t.userId, t.createdAt),
  ],
);
