import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { demoFlag, timestamps } from "./columns";
import { promotionKindEnum, promotionScopeEnum } from "./enums";

/**
 * Promotions module. `value` is basis points for percent_off (10000 = 100%) and cents for
 * amount_off. Scope targets (product/category ids) live in `targetIds`; evaluation happens in the
 * domain layer (Phase 13).
 */
export const promotions = pgTable(
  "promotions",
  {
    id: uuid().primaryKey().defaultRandom(),
    code: text(),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    kind: promotionKindEnum().notNull(),
    scope: promotionScopeEnum().notNull().default("order"),
    targetIds: uuid()
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    value: integer().notNull(),
    minSubtotalCents: integer().notNull().default(0),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }),
    maxRedemptions: integer(),
    maxRedemptionsPerCustomer: integer(),
    stackableWithRewards: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("promotions_code_lower_uq")
      .on(sql`lower(${t.code})`)
      .where(sql`${t.code} is not null`),
    check("promotions_value_positive", sql`${t.value} > 0`),
    check("promotions_percent_max", sql`${t.kind} <> 'percent_off' or ${t.value} <= 10000`),
    check("promotions_window", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
  ],
);
