import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { demoFlag, timestamps } from "./columns";
import {
  earnTriggerEnum,
  loyaltySourceEnum,
  loyaltyTransactionKindEnum,
  redemptionStatusEnum,
  refundShortfallPolicyEnum,
  rewardRefundPolicyEnum,
  rewardStatusEnum,
} from "./enums";
import { users } from "./identity";
import { orderItems, orders } from "./ordering";
import { refunds } from "./payments";

/*
 * Loyalty module: a stamp ledger.
 * - loyalty_transactions is append-only. Every entry has a unique idempotency key naming its source
 *   (e.g. `earn:order:<id>`, `reverse:refund:<id>`), so a repeated webhook, retry or double click
 *   can never earn, reverse or redeem twice.
 * - stamp_balance / stamp_debt on the account are caches updated in the SAME transaction as the
 *   ledger insert, with the account row locked (SELECT … FOR UPDATE). Each entry also records the
 *   balance after it, so the history can be audited line by line.
 * - A partial unique index allows at most one active (reserved|committed) redemption per reward.
 * - loyalty_programs holds immutable rule versions; the newest applies, and entries and rewards
 *   record the version they were made under (changes are not retroactive).
 */

export const loyaltyPrograms = pgTable(
  "loyalty_programs",
  {
    version: integer().primaryKey(),
    stampsPerReward: integer().notNull(),
    earnOn: earnTriggerEnum().notNull().default("paid"),
    minPaidCentsPerDrink: integer().notNull().default(1),
    maxStampsPerPurchase: integer(),
    excludedProductIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    excludedVariantIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    rewardExcludedProductIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    rewardExcludedVariantIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    rewardValueCapCents: integer(),
    rewardCoversModifiers: boolean().notNull().default(false),
    rewardExpiryDays: integer(),
    refundShortfallPolicy: refundShortfallPolicyEnum().notNull().default("carry_forward"),
    rewardOnRefund: rewardRefundPolicyEnum().notNull().default("reinstate"),
    inStoreEnabled: boolean().notNull().default(true),
    inStoreMaxStampsPerVisit: integer().notNull().default(10),
    inStoreMaxStampsPerDay: integer().notNull().default(10),
    /** Days after paying during which a guest can claim the order’s stamps by signing up (0 = off). */
    guestClaimDays: integer().notNull().default(14),
    /** Referral program (off by default): see LoyaltyRules in @ssc/domain. */
    referralEnabled: boolean().notNull().default(false),
    referrerStamps: integer().notNull().default(2),
    refereeStamps: integer().notNull().default(1),
    referralMinOrderCents: integer().notNull().default(500),
    referralMonthlyCap: integer().notNull().default(5),
    /** Why the owner changed the rules (shown in the version history). */
    note: text(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("loyalty_programs_version_positive", sql`${t.version} > 0`),
    check("loyalty_programs_stamps", sql`${t.stampsPerReward} between 2 and 20`),
    check("loyalty_programs_min_paid", sql`${t.minPaidCentsPerDrink} >= 0`),
    check("loyalty_programs_guest_claim", sql`${t.guestClaimDays} between 0 and 90`),
    check(
      "loyalty_programs_referral",
      sql`${t.referrerStamps} between 0 and 10 and ${t.refereeStamps} between 0 and 10 and ${t.referralMinOrderCents} >= 0 and ${t.referralMonthlyCap} between 1 and 50`,
    ),
    check(
      "loyalty_programs_caps",
      sql`(${t.maxStampsPerPurchase} is null or ${t.maxStampsPerPurchase} > 0) and ${t.inStoreMaxStampsPerVisit} > 0 and ${t.inStoreMaxStampsPerDay} > 0`,
    ),
    check(
      "loyalty_programs_reward",
      sql`(${t.rewardValueCapCents} is null or ${t.rewardValueCapCents} > 0) and (${t.rewardExpiryDays} is null or ${t.rewardExpiryDays} > 0)`,
    ),
  ],
);

export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    stampBalance: integer().notNull().default(0),
    /** Stamps owed after a refund of stamps already used (carry-forward policy). */
    stampDebt: integer().notNull().default(0),
    lifetimeStamps: integer().notNull().default(0),
    version: integer().notNull().default(0),
    ...demoFlag,
    ...timestamps,
  },
  (t) => [
    check("loyalty_accounts_balance_nonnegative", sql`${t.stampBalance} >= 0`),
    check("loyalty_accounts_debt_nonnegative", sql`${t.stampDebt} >= 0`),
    check("loyalty_accounts_lifetime_nonnegative", sql`${t.lifetimeStamps} >= 0`),
  ],
);

/** A purchase at the counter, recorded by staff after identifying the customer (QR or lookup). */
export const loyaltyInStoreVisits = pgTable(
  "loyalty_in_store_visits",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    staffUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Till receipt number; unique so one sale can't be recorded twice. Stored normalized. */
    receiptReference: text().notNull(),
    /** Snapshot of what was bought: ids, names, quantities and whether a unit was the free drink. */
    items: jsonb().$type<InStoreVisitItem[]>().notNull(),
    stampsEarned: integer().notNull().default(0),
    programVersion: integer().notNull(),
    idempotencyKey: text().notNull().unique(),
    voidedAt: timestamp({ withTimezone: true }),
    voidedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    voidReason: text(),
    ...demoFlag,
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("loyalty_in_store_visits_receipt_uq").on(t.receiptReference),
    index("loyalty_in_store_visits_account_idx").on(t.accountId, t.createdAt),
    check("loyalty_in_store_visits_stamps", sql`${t.stampsEarned} >= 0`),
    check("loyalty_in_store_visits_void", sql`(${t.voidedAt} is null) = (${t.voidReason} is null)`),
  ],
);

export interface InStoreVisitItem {
  productId: string;
  variantId: string;
  nameFr: string;
  nameEn: string;
  variantNameFr: string;
  variantNameEn: string;
  quantity: number;
  unitPriceCents: number;
  isDrink: boolean;
  loyaltyQualifying: boolean;
  freeUnits: number;
  stamps: number;
}

export const loyaltyTransactions = pgTable(
  "loyalty_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Insertion order (several entries of one operation share a timestamp). */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    accountId: uuid()
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    kind: loyaltyTransactionKindEnum().notNull(),
    source: loyaltySourceEnum().notNull().default("system"),
    /** Signed change to the stamp balance. */
    stamps: integer().notNull(),
    /** Signed change to the stamps owed. */
    debtDelta: integer().notNull().default(0),
    balanceAfter: integer().notNull(),
    debtAfter: integer().notNull().default(0),
    /** Unique per source: the ledger's idempotency guarantee. */
    idempotencyKey: text().notNull().unique(),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    /** Legacy (Phase 3 entries were per order line). */
    orderItemId: uuid().references(() => orderItems.id, { onDelete: "set null" }),
    refundId: uuid().references(() => refunds.id, { onDelete: "set null" }),
    inStoreVisitId: uuid().references(() => loyaltyInStoreVisits.id, { onDelete: "set null" }),
    rewardId: uuid().references((): AnyPgColumn => rewards.id, { onDelete: "set null" }),
    programVersion: integer(),
    /** What the customer sees: lines counted and not counted, order number, cause… */
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Required for manual adjustments; shown to the customer. */
    reason: text(),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("loyalty_transactions_account_idx").on(t.accountId, t.seq),
    index("loyalty_transactions_order_idx").on(t.orderId),
    index("loyalty_transactions_kind_idx").on(t.kind, t.createdAt),
    check(
      "loyalty_transactions_after_nonnegative",
      sql`${t.balanceAfter} >= 0 and ${t.debtAfter} >= 0`,
    ),
    check(
      "loyalty_transactions_sign",
      sql`case ${t.kind}::text
        when 'earn' then ${t.stamps} > 0 and ${t.debtDelta} = 0
        when 'convert' then ${t.stamps} < 0 and ${t.debtDelta} = 0
        when 'reverse' then ${t.stamps} <= 0 and ${t.debtDelta} >= 0
        when 'repay' then ${t.stamps} < 0 and ${t.debtDelta} = ${t.stamps}
        when 'revoke' then ${t.stamps} >= 0 and ${t.debtDelta} = 0 and ${t.rewardId} is not null
        when 'adjust' then (${t.stamps} <> 0 or ${t.debtDelta} < 0) and ${t.debtDelta} <= 0
        else ${t.stamps} = 0 and ${t.debtDelta} = 0 and ${t.rewardId} is not null
      end`,
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
      .references((): AnyPgColumn => loyaltyTransactions.id, { onDelete: "cascade" }),
    /** Stamps it cost (returned if it is revoked to cover a refund). */
    stampsCost: integer().notNull().default(5),
    programVersion: integer(),
    /** Value cap in effect when issued (null = no cap). */
    valueCapCents: integer(),
    coversModifiers: boolean().notNull().default(false),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Null = never expires (default; Québec CPA limits time-based expiry). */
    expiresAt: timestamp({ withTimezone: true }),
    statusChangedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("rewards_account_status_idx").on(t.accountId, t.status),
    check("rewards_cost_positive", sql`${t.stampsCost} > 0`),
  ],
);

export const rewardRedemptions = pgTable(
  "reward_redemptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    rewardId: uuid()
      .notNull()
      .references(() => rewards.id, { onDelete: "restrict" }),
    orderId: uuid().references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid().references(() => orderItems.id, { onDelete: "set null" }),
    inStoreVisitId: uuid().references(() => loyaltyInStoreVisits.id, { onDelete: "restrict" }),
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
    check(
      "reward_redemptions_one_target",
      sql`(${t.orderId} is null) <> (${t.inStoreVisitId} is null)`,
    ),
  ],
);

/**
 * Short-lived codes a customer shows at the counter (as a QR code or read aloud). Staff resolve a
 * code to the account; it expires after a few minutes so screenshots can't be reused.
 */
export const loyaltyCardCodes = pgTable(
  "loyalty_card_codes",
  {
    code: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loyalty_card_codes_user_idx").on(t.userId, t.expiresAt)],
);

/** Each customer's own referral code (created the first time they look at it). */
export const referralCodes = pgTable("referral_codes", {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  code: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const REFERRAL_STATUSES = ["pending", "rewarded", "declined"] as const;

/**
 * A newcomer who entered someone's code. Rewarded (both sides get stamps) when the newcomer's
 * first qualifying order is completed; declined when a limit applies. One per newcomer.
 */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid().primaryKey().defaultRandom(),
    referrerUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refereeUserId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"),
    /** Why it was declined (e.g. "monthly_cap"). */
    reason: text(),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    rewardedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("referrals_referrer_idx").on(t.referrerUserId, t.rewardedAt),
    check("referrals_status", sql`${t.status} in ('pending', 'rewarded', 'declined')`),
    check("referrals_not_self", sql`${t.referrerUserId} <> ${t.refereeUserId}`),
  ],
);
