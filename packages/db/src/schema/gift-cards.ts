import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { GiftCardStatus } from "@ssc/domain";
import { demoFlag, timestamps } from "./columns";
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
