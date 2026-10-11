import {
  and,
  eq,
  inArray,
  loyaltyAccounts,
  loyaltyTransactions,
  orderItems,
  rewardRedemptions,
  rewards,
  sql,
  type Tx,
} from "@ssc/db";
import { DEFAULT_STAMPS_PER_REWARD } from "@ssc/domain";
import { required } from "../../errors";

/*
 * Loyalty ledger operations. Every function runs inside the caller's transaction and locks the
 * account row (SELECT … FOR UPDATE) before touching balances, so concurrent payments, refunds or
 * redemptions for the same customer are serialized. Unique (order_item_id, kind) makes earning and
 * reversing idempotent per order line.
 */

async function lockAccount(tx: Tx, userId: string) {
  const [account] = await tx
    .select()
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.userId, userId))
    .for("update");
  return account;
}

/**
 * Earn one stamp per qualifying drink unit on a paid order (the free reward drink earns nothing),
 * then convert every full card into a reward. Returns stamps earned (0 if already earned).
 */
export async function earnForOrder(
  tx: Tx,
  orderId: string,
  userId: string,
  rewardedItemId: string | null,
): Promise<number> {
  const account = await lockAccount(tx, userId);
  if (!account) return 0;
  const items = await tx
    .select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      qualifying: orderItems.loyaltyQualifying,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  let earned = 0;
  for (const item of items) {
    const stamps = item.qualifying ? item.quantity - (item.id === rewardedItemId ? 1 : 0) : 0;
    if (stamps <= 0) continue;
    const inserted = await tx
      .insert(loyaltyTransactions)
      .values({ accountId: account.id, kind: "earn", stamps, orderItemId: item.id })
      .onConflictDoNothing()
      .returning({ id: loyaltyTransactions.id });
    if (inserted.length > 0) earned += stamps;
  }
  if (earned === 0) return 0;

  let balance = account.stampBalance + earned;
  while (balance >= DEFAULT_STAMPS_PER_REWARD) {
    const [convert] = await tx
      .insert(loyaltyTransactions)
      .values({ accountId: account.id, kind: "convert", stamps: -DEFAULT_STAMPS_PER_REWARD })
      .returning({ id: loyaltyTransactions.id });
    await tx
      .insert(rewards)
      .values({ accountId: account.id, sourceTransactionId: required(convert, "conversion").id });
    balance -= DEFAULT_STAMPS_PER_REWARD;
  }
  await tx
    .update(loyaltyAccounts)
    .set({
      stampBalance: balance,
      lifetimeStamps: account.lifetimeStamps + earned,
      version: sql`${loyaltyAccounts.version} + 1`,
    })
    .where(eq(loyaltyAccounts.id, account.id));
  return earned;
}

/**
 * Reverses stamps earned by a fully refunded order. Stamps already converted into a reward are
 * not clawed back below zero (owner decision D10/LOY-6 default): the balance floors at 0.
 */
export async function reverseForOrder(tx: Tx, orderId: string, userId: string): Promise<number> {
  const account = await lockAccount(tx, userId);
  if (!account) return 0;
  const earned = await tx
    .select({ orderItemId: loyaltyTransactions.orderItemId, stamps: loyaltyTransactions.stamps })
    .from(loyaltyTransactions)
    .innerJoin(orderItems, eq(orderItems.id, loyaltyTransactions.orderItemId))
    .where(and(eq(orderItems.orderId, orderId), eq(loyaltyTransactions.kind, "earn")));

  let reversed = 0;
  let balance = account.stampBalance;
  for (const e of earned) {
    const take = Math.min(e.stamps, balance);
    if (take <= 0) break;
    const inserted = await tx
      .insert(loyaltyTransactions)
      .values({ accountId: account.id, kind: "reverse", stamps: -take, orderItemId: e.orderItemId })
      .onConflictDoNothing()
      .returning({ id: loyaltyTransactions.id });
    if (inserted.length > 0) {
      reversed += take;
      balance -= take;
    }
  }
  if (reversed > 0) {
    await tx
      .update(loyaltyAccounts)
      .set({ stampBalance: balance, version: sql`${loyaltyAccounts.version} + 1` })
      .where(eq(loyaltyAccounts.id, account.id));
  }
  return reversed;
}

/**
 * Reserves a specific available reward for an order. Locks the reward row; fails (returns false)
 * if it was taken by a concurrent checkout — the partial unique index is the final guard.
 */
export async function reserveReward(
  tx: Tx,
  rewardId: string,
  userId: string,
  orderId: string,
  orderItemId: string,
  discountCents: number,
): Promise<boolean> {
  const [reward] = await tx
    .select({ id: rewards.id, status: rewards.status, accountUser: loyaltyAccounts.userId })
    .from(rewards)
    .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
    .where(eq(rewards.id, rewardId))
    .for("update", { of: rewards });
  if (reward?.status !== "available" || reward.accountUser !== userId) return false;
  await tx.update(rewards).set({ status: "reserved" }).where(eq(rewards.id, rewardId));
  await tx
    .insert(rewardRedemptions)
    .values({ rewardId, orderId, orderItemId, discountCents, status: "reserved" });
  return true;
}

/** Commits (on payment) or releases (on cancel/expiry/refund) an order's reward redemption. */
export async function settleRedemption(
  tx: Tx,
  orderId: string,
  outcome: "commit" | "release",
): Promise<void> {
  const active = await tx
    .select({ id: rewardRedemptions.id, rewardId: rewardRedemptions.rewardId })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.orderId, orderId),
        inArray(rewardRedemptions.status, ["reserved", "committed"]),
      ),
    );
  for (const r of active) {
    await tx
      .update(rewardRedemptions)
      .set({ status: outcome === "commit" ? "committed" : "released" })
      .where(eq(rewardRedemptions.id, r.id));
    await tx
      .update(rewards)
      .set({ status: outcome === "commit" ? "redeemed" : "available" })
      .where(eq(rewards.id, r.rewardId));
  }
}
