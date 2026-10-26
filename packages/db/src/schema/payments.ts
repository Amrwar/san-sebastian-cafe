import { sql } from "drizzle-orm";
import type { GiftCardTransactionKind } from "@ssc/domain";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import {
  paymentAttemptStatusEnum,
  paymentProviderEnum,
  paymentStatusEnum,
  refundStatusEnum,
} from "./enums";
import { users } from "./identity";
import { giftCards } from "./gift-cards";
import { orders } from "./ordering";

/*
 * Payments module. No card data is ever stored — only provider references and the display-only
 * brand/last 4 digits the provider returns. Money state changes only from verified provider
 * webhooks or authenticated provider status checks, never from a browser redirect.
 */

/**
 * One attempt to pay an order through the provider's hosted checkout (a Stripe Checkout
 * Session). The partial unique index allows at most one live (open/processing) attempt per order,
 * so a customer can't be sent to two payment pages for the same order.
 */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    provider: paymentProviderEnum().notNull(),
    providerSessionId: text().notNull(),
    status: paymentAttemptStatusEnum().notNull().default("open"),
    amountCents: integer().notNull(),
    /** Provider-hosted payment page. Not a credential: paying still requires the customer's card. */
    checkoutUrl: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastError: text(),
    ...timestamps,
  },
  (t) => [
    unique("payment_attempts_provider_session_uq").on(t.provider, t.providerSessionId),
    uniqueIndex("payment_attempts_one_live_per_order_uq")
      .on(t.orderId)
      .where(sql`${t.status} in ('open', 'processing')`),
    index("payment_attempts_status_idx").on(t.status, t.createdAt),
    check("payment_attempts_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    attemptId: uuid().references(() => paymentAttempts.id, { onDelete: "restrict" }),
    provider: paymentProviderEnum().notNull(),
    providerPaymentId: text().notNull(),
    status: paymentStatusEnum().notNull().default("pending"),
    amountCents: integer().notNull(),
    refundedCents: integer().notNull().default(0),
    currency: text().notNull().default("CAD"),
    /**
     * Set when the money can't pay for the order (it arrived late, twice, or for the wrong amount)
     * and is refunded automatically. Null = the order's own payment.
     */
    reconciliation: text(),
    /** Display-only receipt details if the provider returns them (e.g. "visa", "4242"). */
    cardBrand: text(),
    cardLast4: text(),
    succeededAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("payments_provider_ref_uq").on(t.provider, t.providerPaymentId),
    index("payments_order_idx").on(t.orderId),
    // One payment per order pays for it; any other is a reconciliation (refunded).
    uniqueIndex("payments_one_primary_per_order_uq")
      .on(t.orderId)
      .where(sql`${t.reconciliation} is null and ${t.status} <> 'failed'`),
    check(
      "payments_amounts",
      sql`${t.amountCents} > 0 and ${t.refundedCents} >= 0 and ${t.refundedCents} <= ${t.amountCents}`,
    ),
    check("payments_currency_cad", sql`${t.currency} = 'CAD'`),
    check(
      "payments_reconciliation",
      sql`${t.reconciliation} is null or ${t.reconciliation} in ('late', 'duplicate', 'amount_mismatch')`,
    ),
  ],
);

/**
 * Webhook inbox. The unique (provider, event_id) makes webhook processing idempotent: the row is
 * written in the same transaction as the event's effects, so a failed processing attempt leaves
 * no row and the provider's retry is processed again.
 */
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

/**
 * Refunds. A refund is recorded as `pending` (with who asked and why) BEFORE the provider is
 * called; the provider call uses the refund id as its idempotency key, so a retry after a crash
 * can never refund twice. `status` then follows the provider's answer or its webhooks.
 */
export interface RefundItem {
  orderItemId: string;
  quantity: number;
}

export const refunds = pgTable(
  "refunds",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    paymentId: uuid().references(() => payments.id, { onDelete: "restrict" }),
    /** Money given back to the gift card that paid part of the order (settled at once). */
    giftCardId: uuid().references(() => giftCards.id, { onDelete: "restrict" }),
    amountCents: integer().notNull(),
    reason: text().notNull(),
    status: refundStatusEnum().notNull().default("pending"),
    providerRefundId: text(),
    requestedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** "staff" · "customer_cancel" · "system" (late/duplicate payment) · "provider" (dashboard). */
    source: text().notNull().default("staff"),
    failureReason: text(),
    submittedAt: timestamp({ withTimezone: true }),
    settledAt: timestamp({ withTimezone: true }),
    /**
     * Order lines (and how many units) this refund gives money back for. Their stamps are reversed
     * when the refund succeeds. Empty for an amount-only (goodwill) refund.
     */
    items: jsonb().$type<RefundItem[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    index("refunds_order_idx").on(t.orderId),
    index("refunds_status_idx").on(t.status, t.createdAt),
    uniqueIndex("refunds_provider_ref_uq")
      .on(t.providerRefundId)
      .where(sql`${t.providerRefundId} is not null`),
    check("refunds_amount_positive", sql`${t.amountCents} > 0`),
    check("refunds_one_tender", sql`${t.paymentId} is null or ${t.giftCardId} is null`),
    check("refunds_source", sql`${t.source} in ('staff', 'customer_cancel', 'system', 'provider')`),
  ],
);

/** The provider's customer record for a signed-in customer (lets them reuse saved cards). */
export const paymentCustomers = pgTable(
  "payment_customers",
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: paymentProviderEnum().notNull(),
    providerCustomerId: text().notNull(),
    ...timestamps,
  },
  (t) => [
    unique("payment_customers_user_provider_uq").on(t.userId, t.provider),
    unique("payment_customers_provider_ref_uq").on(t.provider, t.providerCustomerId),
  ],
);

/** Chargebacks reported by the provider. Recorded for staff follow-up; never changes the order. */
export const paymentDisputes = pgTable(
  "payment_disputes",
  {
    id: uuid().primaryKey().defaultRandom(),
    paymentId: uuid().references(() => payments.id, { onDelete: "restrict" }),
    orderId: uuid().references(() => orders.id, { onDelete: "restrict" }),
    provider: paymentProviderEnum().notNull(),
    providerDisputeId: text().notNull(),
    amountCents: integer().notNull(),
    reason: text(),
    status: text().notNull(),
    evidenceDueBy: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("payment_disputes_provider_ref_uq").on(t.provider, t.providerDisputeId),
    index("payment_disputes_status_idx").on(t.status),
  ],
);

/** Every change to a gift card balance, with what caused it. */
export const giftCardTransactions = pgTable(
  "gift_card_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    giftCardId: uuid()
      .notNull()
      .references(() => giftCards.id, { onDelete: "restrict" }),
    kind: text().$type<GiftCardTransactionKind>().notNull(),
    /** Added (positive) or spent (negative). */
    deltaCents: integer().notNull(),
    balanceAfterCents: integer().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    refundId: uuid().references(() => refunds.id, { onDelete: "set null" }),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gift_card_transactions_card_idx").on(t.giftCardId, t.createdAt),
    index("gift_card_transactions_order_idx").on(t.orderId),
    check(
      "gift_card_transactions_kind",
      sql`${t.kind} in ('issue', 'redeem', 'release', 'refund', 'adjustment')`,
    ),
    check("gift_card_transactions_balance", sql`${t.balanceAfterCents} >= 0`),
  ],
);
