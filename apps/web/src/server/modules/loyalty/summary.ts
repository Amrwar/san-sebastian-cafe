import {
  asc,
  count,
  desc,
  eq,
  loyaltyAccounts,
  loyaltyTransactions,
  orders,
  rewards,
  type Database,
} from "@ssc/db";
import { type LoyaltySource, type LoyaltyTransactionKind, type RewardStatus } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";
import { required } from "../../errors";
import type { LedgerDetails } from "./details";
import { LoyaltyLedger } from "./ledger";
import { currentRules } from "./program";

export interface LedgerEntryView {
  id: string;
  kind: LoyaltyTransactionKind;
  source: LoyaltySource;
  stamps: number;
  debtDelta: number;
  balanceAfter: number;
  debtAfter: number;
  createdAt: Date;
  orderId: string | null;
  orderNumber: string | null;
  details: LedgerDetails;
  /** Adjustment reason (written by staff knowing the customer sees it). */
  reason: string | null;
}

export interface RewardView {
  id: string;
  status: RewardStatus;
  issuedAt: Date;
  expiresAt: Date | null;
  valueCapCents: number | null;
  coversModifiers: boolean;
}

export interface LoyaltySummary {
  stampsPerReward: number;
  rewardExpiryDays: number | null;
  inStoreEnabled: boolean;
  /** Stamps toward the next reward (0…stampsPerReward−1). */
  stampBalance: number;
  /** Stamps owed after a refund; settled by the next stamps earned. */
  stampDebt: number;
  lifetimeStamps: number;
  availableRewards: RewardView[];
  /** Rewards held by an order awaiting payment. */
  reservedRewards: number;
  history: LedgerEntryView[];
  historyTotal: number;
  isDemo: boolean;
}

export const HISTORY_PAGE_SIZE = 25;

/** A page of an account's ledger, newest first, with the order numbers it refers to. */
export async function ledgerHistory(
  db: Database,
  accountId: string,
  { limit = HISTORY_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ entries: LedgerEntryView[]; total: number }> {
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: loyaltyTransactions.id,
        kind: loyaltyTransactions.kind,
        source: loyaltyTransactions.source,
        stamps: loyaltyTransactions.stamps,
        debtDelta: loyaltyTransactions.debtDelta,
        balanceAfter: loyaltyTransactions.balanceAfter,
        debtAfter: loyaltyTransactions.debtAfter,
        createdAt: loyaltyTransactions.createdAt,
        orderId: loyaltyTransactions.orderId,
        orderNumber: orders.number,
        details: loyaltyTransactions.details,
        reason: loyaltyTransactions.reason,
      })
      .from(loyaltyTransactions)
      .leftJoin(orders, eq(orders.id, loyaltyTransactions.orderId))
      .where(eq(loyaltyTransactions.accountId, accountId))
      .orderBy(desc(loyaltyTransactions.seq))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.accountId, accountId)),
  ]);
  return {
    entries: rows,
    total: total?.n ?? 0,
  };
}

/** Rewards of an account (available and reserved by default). */
export async function accountRewards(
  db: Database,
  accountId: string,
  statuses: RewardStatus[] = ["available", "reserved"],
): Promise<RewardView[]> {
  const rows = await db
    .select({
      id: rewards.id,
      status: rewards.status,
      issuedAt: rewards.issuedAt,
      expiresAt: rewards.expiresAt,
      valueCapCents: rewards.valueCapCents,
      coversModifiers: rewards.coversModifiers,
    })
    .from(rewards)
    .where(eq(rewards.accountId, accountId))
    .orderBy(asc(rewards.issuedAt));
  return rows.filter((r) => statuses.includes(r.status));
}

/** Expires due rewards of one account (no-op unless the program sets an expiry). */
export async function expireAccountRewards(db: Database, accountId: string, now: Date) {
  await db.transaction(async (tx) => {
    const ledger = await LoyaltyLedger.forAccount(tx, accountId, await currentRules(tx), now);
    if (!ledger) return;
    if ((await ledger.expireDue()) > 0) await ledger.save();
  });
}

/** The signed-in customer's stamp card, rewards wallet and full ledger history (paginated). */
export async function getLoyaltySummary(
  db: Database,
  actor: Actor | null,
  { page = 1, now = new Date() }: { page?: number; now?: Date } = {},
): Promise<LoyaltySummary> {
  authorize(actor, "loyalty:read_own");
  const rules = await currentRules(db);
  let account = await db.query.loyaltyAccounts.findFirst({
    where: eq(loyaltyAccounts.userId, actor.userId),
  });
  const base = {
    stampsPerReward: rules.stampsPerReward,
    rewardExpiryDays: rules.rewardExpiryDays,
    inStoreEnabled: rules.inStoreEnabled,
  };
  if (!account) {
    return {
      ...base,
      stampBalance: 0,
      stampDebt: 0,
      lifetimeStamps: 0,
      availableRewards: [],
      reservedRewards: 0,
      history: [],
      historyTotal: 0,
      isDemo: false,
    };
  }
  if (rules.rewardExpiryDays !== null || (await hasExpiringRewards(db, account.id))) {
    await expireAccountRewards(db, account.id, now);
    account = required(
      await db.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.id, account.id) }),
      "loyalty account",
    );
  }

  const safePage = Math.max(1, Math.floor(page));
  const [wallet, history] = await Promise.all([
    accountRewards(db, account.id),
    ledgerHistory(db, account.id, { offset: (safePage - 1) * HISTORY_PAGE_SIZE }),
  ]);
  return {
    ...base,
    stampBalance: account.stampBalance,
    stampDebt: account.stampDebt,
    lifetimeStamps: account.lifetimeStamps,
    availableRewards: wallet.filter((r) => r.status === "available"),
    reservedRewards: wallet.filter((r) => r.status === "reserved").length,
    history: history.entries,
    historyTotal: history.total,
    isDemo: account.isDemo,
  };
}

async function hasExpiringRewards(db: Database, accountId: string): Promise<boolean> {
  const rows = await accountRewards(db, accountId, ["available"]);
  return rows.some((r) => r.expiresAt !== null);
}
