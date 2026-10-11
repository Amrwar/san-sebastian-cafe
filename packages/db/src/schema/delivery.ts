import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { demoFlag, timestamps } from "./columns";

/**
 * Delivery configuration. Delivery is enabled only when at least one active zone exists.
 * Zones match Canadian postal-code prefixes (FSA, e.g. "H2T"); polygons can be added later.
 */
export const deliveryZones = pgTable(
  "delivery_zones",
  {
    id: uuid().primaryKey().defaultRandom(),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    postalPrefixes: text().array().notNull(),
    feeCents: integer().notNull(),
    minimumOrderCents: integer().notNull().default(0),
    estimatedMinutes: integer().notNull(),
    isActive: boolean().notNull().default(false),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    check(
      "delivery_zones_amounts",
      sql`${t.feeCents} >= 0 and ${t.minimumOrderCents} >= 0 and ${t.estimatedMinutes} > 0`,
    ),
    check("delivery_zones_prefixes", sql`cardinality(${t.postalPrefixes}) > 0`),
  ],
);
