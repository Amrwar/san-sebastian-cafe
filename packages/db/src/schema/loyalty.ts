import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { demoFlag, timestamps } from "./columns";
import { loyaltyTransactionKindEnum, redemptionStatusEnum, rewardStatusEnum } from "./enums";
import { users } from "./identity";
import { orderItems, orders } from "./ordering";

/*
 * Loyalty module: a stamp ledger.
 * - loyalty_transactions is append-only; stamp_balance on the account is a cache that is updated
 *   in the SAME transaction as the ledger insert, with the account row locked (SELECT … FOR UPDATE).
 * - A unique (order_item_id, kind) makes earning/reversing per order line idempotent.
 * - A partial unique index allows at most one active (reserved|committed) redemption per reward.
 */
export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    stampBalance: integer().notNull().default(0),
    lifetimeStamps: integer().notNull().default(0),
    version: integer().notNull().default(0),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    check("loyalty_accounts_balance_nonnegative", sql`${t.stampBalance} >= 0`),
    check("loyalty_accounts_lifetime_nonnegative", sql`${t.lifetimeStamps} >= 0`),
  ],
);

export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    kind: loyaltyTransactionKindEnum().notNull(),
    /** Signed stamp delta: earn > 0, reverse/convert < 0, adjust either way. */
    stamps: integer().notNull(),
    orderItemId: uuid().references(() => orderItems.id, { onDelete: "set null" }),
    /** Required for manual adjustments. */
    reason: text(),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("loyalty_transactions_account_idx").on(t.accountId, t.createdAt),
    uniqueIndex("loyalty_transactions_item_kind_uq")
      .on(t.orderItemId, t.kind)
      .where(sql`${t.orderItemId} is not null`),
    check("loyalty_transactions_nonzero", sql`${t.stamps} <> 0`),
    check(
      "loyalty_transactions_sign",
      sql`(${t.kind} = 'earn' and ${t.stamps} > 0) or (${t.kind} in ('reverse', 'convert') and ${t.stamps} < 0) or ${t.kind} = 'adjust'`,
    ),
    check(
      "loyalty_transactions_adjust_reason",
      sql`${t.kind} <> 'adjust' or ${t.reason} is not null`,
    ),
  ],
);

/** One row per earned free drink. */
export const rewards = pgTable(
  "rewards",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    status: rewardStatusEnum().notNull().default("available"),
    /** The `convert` ledger entry that produced this reward. */
    sourceTransactionId: uuid()
      .notNull()
      .unique()
      .references(() => loyaltyTransactions.id, { onDelete: "cascade" }),
    /** Value cap in effect when issued (null = no cap). */
    valueCapCents: integer(),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("rewards_account_status_idx").on(t.accountId, t.status)],
);

export const rewardRedemptions = pgTable(
  "reward_redemptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    rewardId: uuid()
      .notNull()
      .references(() => rewards.id, { onDelete: "restrict" }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid().references(() => orderItems.id, { onDelete: "set null" }),
    status: redemptionStatusEnum().notNull().default("reserved"),
    discountCents: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("reward_redemptions_one_active_uq")
      .on(t.rewardId)
      .where(sql`${t.status} in ('reserved', 'committed')`),
    index("reward_redemptions_order_idx").on(t.orderId),
    check("reward_redemptions_discount_nonnegative", sql`${t.discountCents} >= 0`),
  ],
);
