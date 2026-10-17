import {
  and,
  desc,
  eq,
  gt,
  loyaltyAccounts,
  loyaltyCardCodes,
  loyaltyInStoreVisits,
  rewards,
  sql,
  users,
  type Database,
} from "@ssc/db";
import { isCardCode, LOYALTY_RULE_LIMITS as L, normalizeCardCode } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, unprocessable } from "../../errors";
import { LoyaltyLedger } from "./ledger";
import { currentRules } from "./program";
import { accountRewards, ledgerHistory, type LedgerEntryView, type RewardView } from "./summary";

/*
 * Loyalty support at the counter and by phone: find a customer (minimum PII), see their card and
 * history, and — shift lead or above — correct it with a reason the customer will see.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** a•••@example.com — enough to confirm with the customer, not enough to collect. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export interface LoyaltyCustomerMatch {
  userId: string;
  firstName: string;
  maskedEmail: string;
}

/** Finds a customer by exact email or by the code on their phone. */
export async function findLoyaltyCustomer(
  db: Database,
  actor: Actor | null,
  query: string,
  now = new Date(),
): Promise<LoyaltyCustomerMatch | null> {
  authorize(actor, "customers:lookup");
  const q = query.trim();
  if (!q) return null;
  let userId: string | undefined;
  if (q.includes("@")) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = lower(${q})`, eq(users.role, "customer")));
    userId = row?.id;
  } else if (isCardCode(q)) {
    const [row] = await db
      .select({ userId: loyaltyCardCodes.userId })
      .from(loyaltyCardCodes)
      .where(
        and(eq(loyaltyCardCodes.code, normalizeCardCode(q)), gt(loyaltyCardCodes.expiresAt, now)),
      );
    userId = row?.userId;
  }
  if (!userId) return null;
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return user
    ? { userId: user.id, firstName: firstName(user.name), maskedEmail: maskEmail(user.email) }
    : null;
}

export interface StaffVisitView {
  id: string;
  receiptReference: string;
  stampsEarned: number;
  rewardUsed: boolean;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface StaffLoyaltyView extends LoyaltyCustomerMatch {
  stampsPerReward: number;
  stampBalance: number;
  stampDebt: number;
  lifetimeStamps: number;
  rewards: RewardView[];
  history: LedgerEntryView[];
  historyTotal: number;
  visits: StaffVisitView[];
}

/** A customer's card as staff see it (no contact details beyond the masked email). */
export async function getCustomerLoyalty(
  db: Database,
  actor: Actor | null,
  userId: string,
  { page = 1 }: { page?: number } = {},
): Promise<StaffLoyaltyView> {
  authorize(actor, "customers:lookup");
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound("Customer");
  const rules = await currentRules(db);
  const account = await db.query.loyaltyAccounts.findFirst({
    where: eq(loyaltyAccounts.userId, userId),
  });
  const base = {
    userId: user.id,
    firstName: firstName(user.name),
    maskedEmail: maskEmail(user.email),
    stampsPerReward: rules.stampsPerReward,
  };
  if (!account) {
    return {
      ...base,
      stampBalance: 0,
      stampDebt: 0,
      lifetimeStamps: 0,
      rewards: [],
      history: [],
      historyTotal: 0,
      visits: [],
    };
  }
  const offset = (Math.max(1, Math.floor(page)) - 1) * 25;
  const [wallet, history, visits] = await Promise.all([
    accountRewards(db, account.id),
    ledgerHistory(db, account.id, { offset }),
    db
      .select()
      .from(loyaltyInStoreVisits)
      .where(eq(loyaltyInStoreVisits.accountId, account.id))
      .orderBy(desc(loyaltyInStoreVisits.createdAt))
      .limit(10),
  ]);
  return {
    ...base,
    stampBalance: account.stampBalance,
    stampDebt: account.stampDebt,
    lifetimeStamps: account.lifetimeStamps,
    rewards: wallet,
    history: history.entries,
    historyTotal: history.total,
    visits: visits.map((v) => ({
      id: v.id,
      receiptReference: v.receiptReference,
      stampsEarned: v.stampsEarned,
      rewardUsed: v.items.some((i) => i.freeUnits > 0),
      createdAt: v.createdAt,
      voidedAt: v.voidedAt,
      voidReason: v.voidReason,
    })),
  };
}

const reason = z.string().trim().min(3).max(300);
const idempotencyKey = z.string().trim().min(8).max(100);

export const adjustmentInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("stamps"),
      stamps: z
        .number()
        .int()
        .min(L.adjustment.min)
        .max(L.adjustment.max)
        .refine((n) => n !== 0),
      reason,
      idempotencyKey,
    })
    .strict(),
  z.object({ action: z.literal("forgive_debt"), reason, idempotencyKey }).strict(),
  z
    .object({ action: z.literal("void_reward"), rewardId: z.uuid(), reason, idempotencyKey })
    .strict(),
]);
export type AdjustmentInput = z.infer<typeof adjustmentInput>;

/**
 * A manual correction (shift lead or above): add or remove stamps, forgive stamps owed, or withdraw
 * an unused reward. The reason is shown to the customer in their history; every change is audited.
 * Retrying with the same key changes nothing.
 */
export async function adjustLoyalty(
  db: Database,
  actor: Actor | null,
  userId: string,
  raw: unknown,
  now = new Date(),
): Promise<{ stampBalance: number; stampDebt: number; rewardsIssued: number }> {
  authorize(actor, "loyalty:adjust");
  const input = parse(adjustmentInput, raw);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Customer");
  if (user.id === actor.userId) throw unprocessable("own_account");

  return db.transaction(async (tx) => {
    const rules = await currentRules(tx);
    const ledger = await LoyaltyLedger.forUser(tx, userId, rules, now);
    const key = `adjust:${input.idempotencyKey}`;
    const common = {
      kind: "adjust" as const,
      source: "staff" as const,
      idempotencyKey: key,
      reason: input.reason,
      actorUserId: actor.userId,
    };
    let rewardsIssued = 0;
    if (await ledger.has(key)) {
      return { stampBalance: ledger.state.balance, stampDebt: ledger.state.debt, rewardsIssued };
    }

    if (input.action === "stamps") {
      if (input.stamps > 0) {
        rewardsIssued = await ledger.credit(input.stamps, {
          ...common,
          details: { action: "stamps" },
        });
      } else {
        if (-input.stamps > ledger.state.balance) {
          throw new AppError("validation_failed", "Not enough stamps", [
            { path: "stamps", code: "exceeds_balance" },
          ]);
        }
        await ledger.append({ ...common, stamps: input.stamps, details: { action: "stamps" } });
      }
    } else if (input.action === "forgive_debt") {
      if (ledger.state.debt === 0) throw unprocessable("no_debt");
      await ledger.append({
        ...common,
        debtDelta: -ledger.state.debt,
        details: { action: "forgive_debt" },
      });
    } else {
      const [reward] = await tx
        .select({ id: rewards.id, status: rewards.status })
        .from(rewards)
        .where(and(eq(rewards.id, input.rewardId), eq(rewards.accountId, ledger.account.id)))
        .for("update");
      if (!reward) throw notFound("Reward");
      if (reward.status !== "available") throw unprocessable("reward_not_available");
      await ledger.setRewardStatus(reward.id, "revoked");
      await ledger.append({
        ...common,
        kind: "revoke",
        rewardId: reward.id,
        details: { action: "void_reward" },
      });
    }
    const state = await ledger.save();
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "loyalty.adjusted",
      entityType: "loyalty_account",
      entityId: ledger.account.id,
      metadata: {
        action: input.action,
        reason: input.reason,
        ...(input.action === "stamps" ? { stamps: input.stamps } : {}),
        ...(input.action === "void_reward" ? { rewardId: input.rewardId } : {}),
      },
    });
    return { stampBalance: state.balance, stampDebt: state.debt, rewardsIssued };
  });
}
