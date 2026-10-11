import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { paymentProviderEnum, paymentStatusEnum } from "./enums";
import { orders } from "./ordering";

/*
 * Payments module. No card data is ever stored, only provider references.
 * Payment status changes come exclusively from verified provider webhooks (payment_events).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    provider: paymentProviderEnum().notNull(),
    providerPaymentId: text().notNull(),
    status: paymentStatusEnum().notNull().default("pending"),
    amountCents: integer().notNull(),
    refundedCents: integer().notNull().default(0),
    currency: text().notNull().default("CAD"),
    /** Display-only receipt details if the provider returns them (e.g. "visa", "4242"). */
    cardBrand: text(),
    cardLast4: text(),
    succeededAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("payments_provider_ref_uq").on(t.provider, t.providerPaymentId),
    index("payments_order_idx").on(t.orderId),
    check(
      "payments_amounts",
      sql`${t.amountCents} > 0 and ${t.refundedCents} >= 0 and ${t.refundedCents} <= ${t.amountCents}`,
    ),
    check("payments_currency_cad", sql`${t.currency} = 'CAD'`),
  ],
);

/** Webhook inbox. The unique (provider, event_id) makes webhook processing idempotent. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: paymentProviderEnum().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    error: text(),
  },
  (t) => [unique("payment_events_provider_event_uq").on(t.provider, t.eventId)],
);
