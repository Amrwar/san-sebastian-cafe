import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  loyaltyAccounts,
  loyaltyTransactions,
  lte,
  rewardRedemptions,
  rewards,
  sql,
  type Tx,
} from "@ssc/db";
import {
  planEarn,
  planReversal,
  rewardExpiry,
  type LoyaltyRules,
  type LoyaltySource,
  type LoyaltyTransactionKind,
} from "@ssc/domain";
import { required } from "../../errors";
import type { LedgerDetails } from "./details";

/*
 * The loyalty ledger. Every write goes through a LoyaltyLedger opened inside the caller's
 * transaction: opening it locks the account row (SELECT … FOR UPDATE), so concurrent payments,
 * refunds, in-store visits, redemptions and adjustments for one customer run one after another.
 *
 * Idempotency: each operation has a primary key naming its source (`earn:order:<id>`,
 * `reverse:refund:<id>`, `earn:visit:<id>`, `adjust:<client key>`…). The ledger checks it under
 * the lock and the unique index on idempotency_key is the final guard, so a repeated webhook,
 * retried job or double-clicked button changes nothing the second time.
 *
 * Lock order everywhere: order → loyalty account → reward rows.
 */

type AccountRow = typeof loyaltyAccounts.$inferSelect;
type RewardRow = typeof rewards.$inferSelect;

export interface EntryInput {
  kind: LoyaltyTransactionKind;
  source: LoyaltySource;
  idempotencyKey: string;
  stamps?: number;
  debtDelta?: number;
  orderId?: string | null;
  refundId?: string | null;
  inStoreVisitId?: string | null;
  rewardId?: string | null;
  details?: LedgerDetails;
  reason?: string | null;
  actorUserId?: string | null;
}

export class LoyaltyLedger {
  private balance: number;
  private debt: number;
  private earned = 0;
  private dirty = false;

  private constructor(
    private readonly tx: Tx,
    readonly account: AccountRow,
    readonly rules: LoyaltyRules,
    private readonly now: Date,
  ) {
    this.balance = account.stampBalance;
    this.debt = account.stampDebt;
  }

  /** Locks (creating if needed) a customer's account. */
  static async forUser(tx: Tx, userId: string, rules: LoyaltyRules, now: Date) {
    const lock = () =>
      tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, userId)).for("update");
    let [account] = await lock();
    if (!account) {
      await tx.insert(loyaltyAccounts).values({ userId }).onConflictDoNothing();
      [account] = await lock();
    }
    return new LoyaltyLedger(tx, required(account, "loyalty account"), rules, now);
  }

  static async forAccount(tx: Tx, accountId: string, rules: LoyaltyRules, now: Date) {
    const [account] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.id, accountId))
      .for("update");
    return account ? new LoyaltyLedger(tx, account, rules, now) : null;
  }

  get state() {
    return { balance: this.balance, debt: this.debt };
  }

  async has(idempotencyKey: string): Promise<boolean> {
    const [row] = await this.tx
      .select({ id: loyaltyTransactions.id })
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.idempotencyKey, idempotencyKey));
    return row !== undefined;
  }

  /** Appends one entry and moves the cached balance. Returns null if the key was already used. */
  async append(entry: EntryInput): Promise<string | null> {
    const stamps = entry.stamps ?? 0;
    const debtDelta = entry.debtDelta ?? 0;
    const [row] = await this.tx
      .insert(loyaltyTransactions)
      .values({
        accountId: this.account.id,
        kind: entry.kind,
        source: entry.source,
        stamps,
        debtDelta,
        balanceAfter: this.balance + stamps,
        debtAfter: this.debt + debtDelta,
        idempotencyKey: entry.idempotencyKey,
        orderId: entry.orderId ?? null,
        refundId: entry.refundId ?? null,
        inStoreVisitId: entry.inStoreVisitId ?? null,
        rewardId: entry.rewardId ?? null,
        programVersion: this.rules.version,
        details: (entry.details ?? {}) as Record<string, unknown>,
        reason: entry.reason ?? null,
        actorUserId: entry.actorUserId ?? null,
        createdAt: this.now,
      })
      .onConflictDoNothing({ target: loyaltyTransactions.idempotencyKey })
      .returning({ id: loyaltyTransactions.id });
    if (!row) return null;
    this.balance += stamps;
    this.debt += debtDelta;
    this.dirty = true;
    return row.id;
  }

  /**
   * Adds stamps (purchase or positive adjustment): the entry itself, then stamps owed are settled,
   * then every full card becomes a reward. Returns the rewards issued (0 if already applied).
   */
  async credit(stamps: number, entry: Omit<EntryInput, "stamps">): Promise<number> {
    if (stamps <= 0) return 0;
    const plan = planEarn(this.state, stamps, this.rules.stampsPerReward);
    const id = await this.append({ ...entry, stamps });
    if (!id) return 0;
    if (entry.kind === "earn") this.earned += stamps;
    const base = {
      source: entry.source,
      orderId: entry.orderId,
      inStoreVisitId: entry.inStoreVisitId,
    };
    if (plan.repaid > 0) {
      await this.append({
        ...base,
        kind: "repay",
        idempotencyKey: `${entry.idempotencyKey}:repay`,
        stamps: -plan.repaid,
        debtDelta: -plan.repaid,
      });
    }
    for (let i = 1; i <= plan.rewards; i++) {
      await this.issueReward({ ...base, idempotencyKey: `${entry.idempotencyKey}:convert:${i}` });
    }
    return plan.rewards;
  }

  private async issueReward(
    entry: Pick<EntryInput, "source" | "orderId" | "inStoreVisitId" | "idempotencyKey">,
  ) {
    const cost = this.rules.stampsPerReward;
    const convertId = required(
      await this.append({ ...entry, kind: "convert", stamps: -cost }),
      "conversion",
    );
    const [reward] = await this.tx
      .insert(rewards)
      .values({
        accountId: this.account.id,
        sourceTransactionId: convertId,
        stampsCost: cost,
        programVersion: this.rules.version,
        valueCapCents: this.rules.rewardValueCapCents,
        coversModifiers: this.rules.rewardCoversModifiers,
        issuedAt: this.now,
        expiresAt: rewardExpiry(this.now, this.rules.rewardExpiryDays),
        statusChangedAt: this.now,
      })
      .returning({ id: rewards.id });
    await this.tx
      .update(loyaltyTransactions)
      .set({ rewardId: required(reward, "reward").id })
      .where(eq(loyaltyTransactions.id, convertId));
  }

  /**
   * Takes stamps back (refund, cancellation, voided visit) following the program's policy: the
   * balance first, then unused rewards (newest first), then stamps owed or written off. Writes a
   * `revoke` entry per withdrawn reward and one `reverse` entry with the explanation.
   */
  async reverse(stamps: number, entry: Omit<EntryInput, "stamps" | "kind" | "debtDelta">) {
    if (stamps <= 0 || (await this.has(entry.idempotencyKey))) return null;
    const available = await this.tx
      .select()
      .from(rewards)
      .where(and(eq(rewards.accountId, this.account.id), eq(rewards.status, "available")))
      .orderBy(desc(rewards.issuedAt))
      .for("update");
    const plan = planReversal(
      this.state,
      stamps,
      available.map((r) => r.stampsCost),
      this.rules.refundShortfallPolicy,
    );
    for (const reward of available.slice(0, plan.revokedRewards)) {
      await this.setRewardStatus(reward.id, "revoked");
      await this.append({
        source: entry.source,
        orderId: entry.orderId,
        refundId: entry.refundId,
        inStoreVisitId: entry.inStoreVisitId,
        kind: "revoke",
        idempotencyKey: `${entry.idempotencyKey}:revoke:${reward.id}`,
        stamps: reward.stampsCost,
        rewardId: reward.id,
        details: { cause: "refund_cover", orderNumber: entry.details?.orderNumber },
      });
    }
    await this.append({
      ...entry,
      kind: "reverse",
      stamps: -plan.fromBalance,
      debtDelta: plan.debtAdded,
      details: { ...entry.details, ...(plan.forgiven > 0 ? { forgiven: plan.forgiven } : {}) },
    });
    return plan;
  }

  /** Marks a committed redemption in the ledger (the free drink was used). */
  async recordRedemption(
    redemptionId: string,
    rewardId: string,
    entry: Pick<EntryInput, "source" | "orderId" | "inStoreVisitId" | "details" | "actorUserId">,
  ) {
    await this.setRewardStatus(rewardId, "redeemed");
    await this.append({
      ...entry,
      kind: "redeem",
      idempotencyKey: `redeem:${redemptionId}`,
      rewardId,
    });
  }

  /** Gives a used reward back (its order was cancelled or refunded, or its visit voided). */
  async reinstate(
    redemptionId: string,
    rewardId: string,
    entry: Pick<EntryInput, "source" | "orderId" | "inStoreVisitId" | "details" | "actorUserId">,
  ) {
    await this.tx
      .update(rewardRedemptions)
      .set({ status: "released" })
      .where(eq(rewardRedemptions.id, redemptionId));
    await this.setRewardStatus(rewardId, "available");
    await this.append({
      ...entry,
      kind: "reinstate",
      idempotencyKey: `reinstate:${redemptionId}`,
      rewardId,
    });
  }

  /** Expires this account's unused rewards whose expiry date has passed. */
  async expireDue(): Promise<number> {
    const due = await this.tx
      .select({ id: rewards.id })
      .from(rewards)
      .where(
        and(
          eq(rewards.accountId, this.account.id),
          eq(rewards.status, "available"),
          isNotNull(rewards.expiresAt),
          lte(rewards.expiresAt, this.now),
        ),
      )
      .for("update");
    for (const r of due) {
      await this.setRewardStatus(r.id, "expired");
      await this.append({
        kind: "expire",
        source: "system",
        idempotencyKey: `expire:${r.id}`,
        rewardId: r.id,
      });
    }
    return due.length;
  }

  async setRewardStatus(rewardId: string, status: RewardRow["status"]) {
    await this.tx
      .update(rewards)
      .set({ status, statusChangedAt: this.now })
      .where(eq(rewards.id, rewardId));
  }

  /** Writes the cached balances back to the (still locked) account row. */
  async save(): Promise<{ balance: number; debt: number }> {
    if (this.dirty) {
      await this.tx
        .update(loyaltyAccounts)
        .set({
          stampBalance: this.balance,
          stampDebt: this.debt,
          lifetimeStamps: sql`${loyaltyAccounts.lifetimeStamps} + ${this.earned}`,
          version: sql`${loyaltyAccounts.version} + 1`,
        })
        .where(eq(loyaltyAccounts.id, this.account.id));
      this.dirty = false;
      this.earned = 0;
    }
    return this.state;
  }
}

/**
 * Reserves a specific reward for an order being placed. Locks the reward row; returns false if it
 * is not this customer's, not available, or expired. The partial unique index on active
 * redemptions is the final guard against two checkouts taking the same reward.
 */
export async function reserveReward(
  tx: Tx,
  rewardId: string,
  userId: string,
  orderId: string,
  orderItemId: string,
  discountCents: number,
  now: Date,
): Promise<boolean> {
  const [reward] = await tx
    .select({
      id: rewards.id,
      status: rewards.status,
      expiresAt: rewards.expiresAt,
      accountUser: loyaltyAccounts.userId,
    })
    .from(rewards)
    .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
    .where(eq(rewards.id, rewardId))
    .for("update", { of: rewards });
  if (reward?.status !== "available" || reward.accountUser !== userId) return false;
  if (reward.expiresAt && reward.expiresAt <= now) return false;
  await tx
    .update(rewards)
    .set({ status: "reserved", statusChangedAt: now })
    .where(eq(rewards.id, rewardId));
  await tx
    .insert(rewardRedemptions)
    .values({ rewardId, orderId, orderItemId, discountCents, status: "reserved" });
  return true;
}

/** Active (reserved or committed) redemptions of an order. */
export async function activeRedemptions(tx: Tx, orderId: string) {
  return tx
    .select({
      id: rewardRedemptions.id,
      rewardId: rewardRedemptions.rewardId,
      status: rewardRedemptions.status,
    })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.orderId, orderId),
        inArray(rewardRedemptions.status, ["reserved", "committed"]),
      ),
    );
}

/** Frees reservations of an order that was never paid (expired or cancelled before payment). */
export async function releaseReservations(tx: Tx, orderId: string, now: Date): Promise<void> {
  for (const r of await activeRedemptions(tx, orderId)) {
    if (r.status !== "reserved") continue;
    await tx
      .update(rewardRedemptions)
      .set({ status: "released" })
      .where(eq(rewardRedemptions.id, r.id));
    await tx
      .update(rewards)
      .set({ status: "available", statusChangedAt: now })
      .where(eq(rewards.id, r.rewardId));
  }
}
