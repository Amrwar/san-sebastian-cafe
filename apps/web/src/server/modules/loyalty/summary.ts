import {
  and,
  asc,
  desc,
  eq,
  loyaltyAccounts,
  loyaltyTransactions,
  orderItems,
  orders,
  rewards,
  type Database,
} from "@ssc/db";
import { DEFAULT_STAMPS_PER_REWARD, type LoyaltyTransactionKind } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";

export interface LoyaltySummary {
  stampsPerReward: number;
  /** Stamps toward the next reward (0…stampsPerReward−1). */
  stampBalance: number;
  lifetimeStamps: number;
  availableRewards: Array<{ id: string; issuedAt: Date; valueCapCents: number | null }>;
  history: Array<{
    id: string;
    kind: LoyaltyTransactionKind;
    stamps: number;
    createdAt: Date;
    orderNumber: string | null;
    orderId: string | null;
  }>;
  isDemo: boolean;
}

/** The signed-in customer's stamp card, rewards wallet and ledger history. */
export async function getLoyaltySummary(
  db: Database,
  actor: Actor | null,
): Promise<LoyaltySummary> {
  authorize(actor, "loyalty:read_own");
  const account = await db.query.loyaltyAccounts.findFirst({
    where: eq(loyaltyAccounts.userId, actor.userId),
  });
  if (!account) {
    return {
      stampsPerReward: DEFAULT_STAMPS_PER_REWARD,
      stampBalance: 0,
      lifetimeStamps: 0,
      availableRewards: [],
      history: [],
      isDemo: false,
    };
  }

  const [available, history] = await Promise.all([
    db
      .select({ id: rewards.id, issuedAt: rewards.issuedAt, valueCapCents: rewards.valueCapCents })
      .from(rewards)
      .where(and(eq(rewards.accountId, account.id), eq(rewards.status, "available")))
      .orderBy(asc(rewards.issuedAt)),
    db
      .select({
        id: loyaltyTransactions.id,
        kind: loyaltyTransactions.kind,
        stamps: loyaltyTransactions.stamps,
        createdAt: loyaltyTransactions.createdAt,
        orderNumber: orders.number,
        orderId: orders.id,
      })
      .from(loyaltyTransactions)
      .leftJoin(orderItems, eq(orderItems.id, loyaltyTransactions.orderItemId))
      .leftJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(loyaltyTransactions.accountId, account.id))
      .orderBy(desc(loyaltyTransactions.createdAt))
      .limit(50),
  ]);

  return {
    stampsPerReward: DEFAULT_STAMPS_PER_REWARD,
    stampBalance: account.stampBalance,
    lifetimeStamps: account.lifetimeStamps,
    availableRewards: available,
    history,
    isDemo: account.isDemo,
  };
}
