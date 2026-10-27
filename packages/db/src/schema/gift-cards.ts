import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { GiftCardPurchaseStatus, GiftCardStatus } from "@ssc/domain";
import { demoFlag, timestamps } from "./columns";
import { paymentProviderEnum } from "./enums";
import { users } from "./identity";

/*
 * Gift cards (Québec: no expiry, no fees). Only a hash of the code is stored, never the code: it
 * is shown once when the card is issued. No customer data is kept on a card. Every balance change
 * is in gift_card_transactions (payments schema), written in the same transaction.
 */

export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** SHA-256 of the normalized code (the code itself is never stored). */
    codeHash: text().notNull().unique(),
    /** Last four characters, to tell cards apart on screens and receipts. */
    codeLast4: text().notNull(),
    initialCents: integer().notNull(),
    balanceCents: integer().notNull(),
    status: text().$type<GiftCardStatus>().notNull().default("active"),
    issuedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Staff note at issue (e.g. "paid at counter, receipt 1234"). Never customer data. */
    note: text(),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    index("gift_cards_status_idx").on(t.status),
    check("gift_cards_amounts", sql`${t.initialCents} > 0 and ${t.balanceCents} >= 0`),
    check("gift_cards_status", sql`${t.status} in ('active', 'disabled')`),
  ],
);

/**
 * A gift card bought on the site: paid through the provider's hosted page, then the card is issued
 * and its code emailed to the recipient (never stored). Personal details here (names, emails,
 * message) are cleared by the retention job a year on.
 */
export const giftCardPurchases = pgTable(
  "gift_card_purchases",
  {
    id: uuid().primaryKey().defaultRandom(),
    status: text().$type<GiftCardPurchaseStatus>().notNull().default("awaiting_payment"),
    amountCents: integer().notNull(),
    purchaserUserId: text().references(() => users.id, { onDelete: "set null" }),
    purchaserName: text().notNull(),
    purchaserEmail: text().notNull(),
    recipientName: text().notNull(),
    recipientEmail: text().notNull(),
    /** Short note from the purchaser, sent with the card. */
    message: text(),
    locale: text().notNull().default("fr-CA"),
    /** Hash of the link token guests use to follow their purchase (the token is never stored). */
    accessTokenHash: text(),
    provider: paymentProviderEnum().notNull(),
    providerSessionId: text().unique(),
    checkoutUrl: text(),
    /** The hosted page can't be paid after this; a later payment is refunded. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    providerPaymentId: text(),
    paidAt: timestamp({ withTimezone: true }),
    giftCardId: uuid().references(() => giftCards.id, { onDelete: "restrict" }),
    providerRefundId: text(),
    refundedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("gift_card_purchases_status_idx").on(t.status, t.expiresAt),
    index("gift_card_purchases_user_idx").on(t.purchaserUserId),
    check("gift_card_purchases_amount", sql`${t.amountCents} > 0`),
    check(
      "gift_card_purchases_status",
      sql`${t.status} in ('awaiting_payment', 'paid', 'expired', 'refunded')`,
    ),
    check(
      "gift_card_purchases_paid_has_card",
      sql`${t.status} not in ('paid', 'refunded') or ${t.giftCardId} is not null`,
    ),
  ],
);
