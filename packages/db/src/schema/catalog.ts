import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { demoFlag, timestamps } from "./columns";
import { availabilityEnum, modifierSelectionEnum, taxCategoryEnum } from "./enums";

/*
 * Catalog module. Bilingual text is stored as paired *_fr / *_en columns: both are required, which
 * keeps French and English at parity. Rows referenced by historical orders are archived, never
 * deleted (orders keep their own name/price snapshots).
 */

export const categories = pgTable(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    descriptionFr: text(),
    descriptionEn: text(),
    sortOrder: integer().notNull().default(0),
    isVisible: boolean().notNull().default(true),
    archivedAt: timestamp({ withTimezone: true }),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [index("categories_sort_idx").on(t.sortOrder)],
);

export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    slug: text().notNull().unique(),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    descriptionFr: text(),
    descriptionEn: text(),
    imageUrl: text(),
    imageAltFr: text(),
    imageAltEn: text(),
    /** Owner-supplied allergen statement. Never generated. */
    allergenNoteFr: text(),
    allergenNoteEn: text(),
    taxCategory: taxCategoryEnum().notNull().default("standard"),
    isDrink: boolean().notNull().default(false),
    /** Highlighted on the home screen. */
    isFeatured: boolean().notNull().default(false),
    /** Counts toward the "5 drinks → 1 free" stamp card. */
    loyaltyQualifying: boolean().notNull().default(false),
    /** May be chosen as the free reward drink. */
    rewardEligible: boolean().notNull().default(false),
    availability: availabilityEnum().notNull().default("available"),
    /** Temporarily disabled ("86'd") until this instant; restores automatically. */
    unavailableUntil: timestamp({ withTimezone: true }),
    /** Units left when stock is tracked (sold out at 0); null = not tracked. See stock_movements. */
    stockQuantity: integer(),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    index("products_category_idx").on(t.categoryId, t.sortOrder),
    check("products_stock_nonnegative", sql`${t.stockQuantity} is null or ${t.stockQuantity} >= 0`),
    check(
      "products_image_alt_required",
      sql`${t.imageUrl} is null or (${t.imageAltFr} is not null and ${t.imageAltEn} is not null)`,
    ),
    check("products_loyalty_requires_drink", sql`not ${t.loyaltyQualifying} or ${t.isDrink}`),
  ],
);

/** Sellable variants of a product (e.g. sizes). Every product has at least one; price lives here. */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    priceCents: integer().notNull(),
    isDefault: boolean().notNull().default(false),
    availability: availabilityEnum().notNull().default("available"),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("product_variants_product_idx").on(t.productId, t.sortOrder),
    uniqueIndex("product_variants_one_default_uq")
      .on(t.productId)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
    check("product_variants_price_nonnegative", sql`${t.priceCents} >= 0`),
  ],
);

/** Reusable option groups: temperature, milk, syrups, espresso shots, extras. */
export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    selection: modifierSelectionEnum().notNull(),
    minSelected: integer().notNull().default(0),
    maxSelected: integer().notNull().default(1),
    archivedAt: timestamp({ withTimezone: true }),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    check(
      "modifier_groups_bounds",
      sql`${t.minSelected} >= 0 and ${t.maxSelected} >= 1 and ${t.minSelected} <= ${t.maxSelected}`,
    ),
    check("modifier_groups_single_max", sql`${t.selection} <> 'single' or ${t.maxSelected} = 1`),
  ],
);

export const modifierOptions = pgTable(
  "modifier_options",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid()
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
    nameFr: text().notNull(),
    nameEn: text().notNull(),
    /** May be negative (e.g. "no whipped cream" discount) but never makes a line negative — enforced in pricing. */
    priceDeltaCents: integer().notNull().default(0),
    isDefault: boolean().notNull().default(false),
    availability: availabilityEnum().notNull().default("available"),
    /** Temporarily disabled ("86'd") until this instant; restores automatically. */
    unavailableUntil: timestamp({ withTimezone: true }),
    /** Units left when stock is tracked (sold out at 0); null = not tracked. See stock_movements. */
    stockQuantity: integer(),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("modifier_options_group_idx").on(t.groupId, t.sortOrder),
    check(
      "modifier_options_stock_nonnegative",
      sql`${t.stockQuantity} is null or ${t.stockQuantity} >= 0`,
    ),
  ],
);

export const productModifierGroups = pgTable(
  "product_modifier_groups",
  {
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    groupId: uuid()
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "restrict" }),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.groupId] })],
);

/** Weekly windows (local time) when a product can be ordered; no rows = whenever the café is open. */
export const productAvailabilityWindows = pgTable(
  "product_availability_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    weekday: integer().notNull(),
    startMinute: integer().notNull(),
    endMinute: integer().notNull(),
  },
  (t) => [
    index("product_availability_windows_product_idx").on(t.productId),
    check(
      "product_availability_windows_range",
      sql`${t.weekday} between 0 and 6 and ${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.startMinute} < ${t.endMinute}`,
    ),
  ],
);

/**
 * Size-specific option rules: a different price for this size (`price_delta_cents`) and/or the
 * option is not allowed with this size (`excluded`), e.g. "no iced single espresso".
 */
export const variantOptionRules = pgTable(
  "variant_option_rules",
  {
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    optionId: uuid()
      .notNull()
      .references(() => modifierOptions.id, { onDelete: "cascade" }),
    priceDeltaCents: integer(),
    excluded: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.optionId] }),
    check(
      "variant_option_rules_meaningful",
      sql`${t.excluded} or ${t.priceDeltaCents} is not null`,
    ),
  ],
);
