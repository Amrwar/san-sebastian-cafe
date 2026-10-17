import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { productVariants, products } from "./catalog";
import { demoFlag, timestamps } from "./columns";
import { deliveryZones } from "./delivery";
import {
  actorKindEnum,
  orderEventTypeEnum,
  fulfilmentMethodEnum,
  localeEnum,
  orderStatusEnum,
  taxCategoryEnum,
} from "./enums";
import { users } from "./identity";
import { promotions } from "./promotions";

/** Snapshot of a chosen modifier at order time (names and prices frozen). */
export interface OrderItemModifierSnapshot {
  optionId: string;
  groupNameFr: string;
  groupNameEn: string;
  nameFr: string;
  nameEn: string;
  priceDeltaCents: number;
}

/*
 * Ordering module. Totals are computed only by the server-side pricing service and stored with a
 * CHECK that the breakdown adds up. `version` supports optimistic locking on status transitions.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Short human-readable code shown to customer and staff. */
    number: text().notNull().unique(),
    userId: text().references(() => users.id, { onDelete: "set null" }),
    guestEmail: text(),
    guestName: text(),
    status: orderStatusEnum().notNull().default("awaiting_payment"),
    fulfilment: fulfilmentMethodEnum().notNull().default("pickup"),
    deliveryZoneId: uuid().references(() => deliveryZones.id, { onDelete: "restrict" }),
    deliveryAddress: jsonb(),
    /** null = as soon as possible. */
    scheduledFor: timestamp({ withTimezone: true }),
    locale: localeEnum().notNull(),
    /** Customer instructions for the whole order (≤ 200 chars). */
    notes: text(),
    /** Internal preparation notes, visible to staff only. */
    staffNotes: text(),
    guestPhone: text(),
    /** SHA-256 of the guest's tracking token; lets guests follow their order without an account. */
    guestAccessTokenHash: text(),
    /** Start of the capacity slot this order holds (pickup orders). */
    slotStart: timestamp({ withTimezone: true }),
    /** Unpaid orders expire (and free their slot) after this instant. */
    expiresAt: timestamp({ withTimezone: true }),
    cancellationReason: text(),
    promotionId: uuid().references(() => promotions.id, { onDelete: "restrict" }),
    subtotalCents: integer().notNull(),
    discountCents: integer().notNull().default(0),
    rewardDiscountCents: integer().notNull().default(0),
    deliveryFeeCents: integer().notNull().default(0),
    gstCents: integer().notNull(),
    qstCents: integer().notNull(),
    tipCents: integer().notNull().default(0),
    totalCents: integer().notNull(),
    /** Full pricing evidence (rates, rounding, inputs) used to compute the totals. */
    pricingSnapshot: jsonb().notNull(),
    idempotencyKey: text().notNull().unique(),
    version: integer().notNull().default(0),
    placedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    acceptedAt: timestamp({ withTimezone: true }),
    readyAt: timestamp({ withTimezone: true }),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    index("orders_user_idx").on(t.userId, t.placedAt),
    index("orders_status_idx").on(t.status, t.placedAt),
    index("orders_slot_idx").on(t.slotStart, t.status),
    check(
      "orders_customer_identified",
      sql`${t.userId} is not null or ${t.guestEmail} is not null`,
    ),
    check(
      "orders_amounts_nonnegative",
      sql`${t.subtotalCents} >= 0 and ${t.discountCents} >= 0 and ${t.rewardDiscountCents} >= 0 and ${t.deliveryFeeCents} >= 0 and ${t.gstCents} >= 0 and ${t.qstCents} >= 0 and ${t.tipCents} >= 0 and ${t.totalCents} >= 0`,
    ),
    check(
      "orders_total_adds_up",
      sql`${t.totalCents} = ${t.subtotalCents} - ${t.discountCents} - ${t.rewardDiscountCents} + ${t.deliveryFeeCents} + ${t.gstCents} + ${t.qstCents} + ${t.tipCents}`,
    ),
    check(
      "orders_delivery_fields",
      sql`(${t.fulfilment} = 'delivery') = (${t.deliveryZoneId} is not null and ${t.deliveryAddress} is not null)`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    productNameFr: text().notNull(),
    productNameEn: text().notNull(),
    variantNameFr: text().notNull(),
    variantNameEn: text().notNull(),
    modifiers: jsonb().$type<OrderItemModifierSnapshot[]>().notNull().default([]),
    quantity: integer().notNull(),
    /** Variant price + modifier deltas, per unit. */
    unitPriceCents: integer().notNull(),
    lineTotalCents: integer().notNull(),
    /** Share of the promotion discount allocated to this line. */
    discountCents: integer().notNull().default(0),
    /** Free-drink reward applied to this line (one unit). */
    rewardDiscountCents: integer().notNull().default(0),
    taxCategory: taxCategoryEnum().notNull(),
    isDrink: boolean().notNull(),
    loyaltyQualifying: boolean().notNull(),
    /** Customer instruction for this item (e.g. "extra hot"), ≤ 140 chars. */
    notes: text(),
    ...timestamps,
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    check("order_items_quantity_positive", sql`${t.quantity} > 0`),
    check(
      "order_items_amounts",
      sql`${t.unitPriceCents} >= 0 and ${t.lineTotalCents} = ${t.unitPriceCents} * ${t.quantity}`,
    ),
    check(
      "order_items_discounts",
      sql`${t.discountCents} >= 0 and ${t.rewardDiscountCents} >= 0 and ${t.discountCents} + ${t.rewardDiscountCents} <= ${t.lineTotalCents}`,
    ),
  ],
);

/** Append-only status history (who, when, why). */
export const orderStatusEvents = pgTable(
  "order_status_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: orderStatusEnum(),
    toStatus: orderStatusEnum().notNull(),
    actorKind: actorKindEnum().notNull(),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_status_events_order_idx").on(t.orderId, t.createdAt)],
);

/**
 * Complete order history: creation, every status change, payments, refunds and edits, with the
 * actor and structured details. Append-only. (`order_status_events` keeps the compact status
 * timeline used by tracking; both are written in the same transaction.)
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: orderEventTypeEnum().notNull(),
    actorKind: actorKindEnum().notNull(),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    data: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt)],
);

/** Per-day counters for short, unique, human-friendly order numbers (e.g. "1011-007"). */
export const orderCounters = pgTable("order_counters", {
  localDate: date().primaryKey(),
  lastValue: integer().notNull().default(0),
});
