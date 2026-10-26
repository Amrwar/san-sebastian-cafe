import { randomInt } from "node:crypto";
import {
  and,
  count,
  eq,
  gte,
  isNotNull,
  orders,
  referralCodes,
  referrals,
  users,
  type Database,
  type Tx,
} from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound, unprocessable } from "../../errors";
import { LoyaltyLedger } from "./ledger";
import { currentRules } from "./program";

/*
 * Referral program (decision D17, off until the owner turns it on in the loyalty rules).
 *
 * A newcomer enters a customer's code from their rewards page. When the newcomer's first order
 * that reaches the minimum is completed, both get stamps on their card. Limits against abuse:
 * - only a new account (created in the last 30 days, no paid order yet) can enter a code, once;
 * - no referring yourself; the referrer must be a real customer (at least one paid order);
 * - a referrer earns from at most `referralMonthlyCap` referrals in any 30 days;
 * - the reward waits for a completed order (not just paid), so cancelled orders earn nothing.
 */

const DAY_MS = 86_400_000;
const NEW_ACCOUNT_DAYS = 30;
/** No 0/O or 1/I: codes are read out loud at the counter too. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  return Array.from({ length: 7 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

export interface MyReferral {
  enabled: boolean;
  code: string | null;
  referrerStamps: number;
  refereeStamps: number;
  /** Whether this account may still enter someone's code. */
  canEnterCode: boolean;
  /** Set once this account entered a code. */
  referredStatus: "pending" | "rewarded" | "declined" | null;
  rewardedReferrals: number;
}

async function paidOrderCount(db: Database | Tx, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.userId, userId), isNotNull(orders.paidAt)));
  return row?.n ?? 0;
}

/** The customer's referral page data; creates their code the first time. */
export async function getMyReferral(
  db: Database,
  actor: Actor | null,
  now = new Date(),
): Promise<MyReferral> {
  authorize(actor, "loyalty:read_own");
  const rules = await currentRules(db);
  const [mine] = await db.select().from(referrals).where(eq(referrals.refereeUserId, actor.userId));
  const [rewarded] = await db
    .select({ n: count() })
    .from(referrals)
    .where(and(eq(referrals.referrerUserId, actor.userId), eq(referrals.status, "rewarded")));
  const base = {
    enabled: rules.referralEnabled,
    referrerStamps: rules.referrerStamps,
    refereeStamps: rules.refereeStamps,
    referredStatus: (mine?.status as MyReferral["referredStatus"]) ?? null,
    rewardedReferrals: rewarded?.n ?? 0,
  };
  if (!rules.referralEnabled) return { ...base, code: null, canEnterCode: false };

  let [row] = await db.select().from(referralCodes).where(eq(referralCodes.userId, actor.userId));
  for (let attempt = 0; !row && attempt < 5; attempt++) {
    [row] = await db
      .insert(referralCodes)
      .values({ userId: actor.userId, code: newCode() })
      .onConflictDoNothing()
      .returning();
    row ??= (
      await db.select().from(referralCodes).where(eq(referralCodes.userId, actor.userId))
    )[0];
  }
  return {
    ...base,
    code: row?.code ?? null,
    canEnterCode: !mine && (await eligibleNewcomer(db, actor.userId, now)),
  };
}

async function eligibleNewcomer(db: Database | Tx, userId: string, now: Date): Promise<boolean> {
  const [user] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || now.getTime() - user.createdAt.getTime() > NEW_ACCOUNT_DAYS * DAY_MS) return false;
  return (await paidOrderCount(db, userId)) === 0;
}

const codeInput = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{7}$/),
  })
  .strict();

/** A newcomer enters a referral code. */
export async function enterReferralCode(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<void> {
  authorize(actor, "profile:update_own");
  const parsed = codeInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  await db.transaction(async (tx) => {
    const rules = await currentRules(tx);
    if (!rules.referralEnabled) throw unprocessable("referrals_off");
    const [owner] = await tx
      .select({ userId: referralCodes.userId })
      .from(referralCodes)
      .where(eq(referralCodes.code, parsed.data.code));
    if (!owner) throw notFound("Referral code");
    if (owner.userId === actor.userId) throw unprocessable("own_code");
    const [already] = await tx
      .select({ id: referrals.id })
      .from(referrals)
      .where(eq(referrals.refereeUserId, actor.userId));
    if (already) throw unprocessable("already_referred");
    if (!(await eligibleNewcomer(tx, actor.userId, now))) throw unprocessable("not_new_customer");
    if ((await paidOrderCount(tx, owner.userId)) === 0) throw unprocessable("referrer_inactive");
    const [row] = await tx
      .insert(referrals)
      .values({ referrerUserId: owner.userId, refereeUserId: actor.userId, createdAt: now })
      .returning({ id: referrals.id });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "loyalty.referral_recorded",
      entityType: "referral",
      entityId: row?.id,
    });
  });
}

/**
 * Called when an order is completed (same transaction): rewards a pending referral if this is the
 * newcomer's qualifying first order.
 */
export async function rewardReferral(
  tx: Tx,
  order: typeof orders.$inferSelect,
  now: Date,
): Promise<void> {
  if (!order.userId) return;
  const [referral] = await tx
    .select()
    .from(referrals)
    .where(and(eq(referrals.refereeUserId, order.userId), eq(referrals.status, "pending")))
    .for("update");
  if (!referral) return;
  const rules = await currentRules(tx);
  if (!rules.referralEnabled) return;
  if (order.totalCents - order.tipCents < rules.referralMinOrderCents) return;

  const [recent] = await tx
    .select({ n: count() })
    .from(referrals)
    .where(
      and(
        eq(referrals.referrerUserId, referral.referrerUserId),
        eq(referrals.status, "rewarded"),
        gte(referrals.rewardedAt, new Date(now.getTime() - 30 * DAY_MS)),
      ),
    );
  if ((recent?.n ?? 0) >= rules.referralMonthlyCap) {
    await tx
      .update(referrals)
      .set({ status: "declined", reason: "monthly_cap", orderId: order.id })
      .where(eq(referrals.id, referral.id));
    return;
  }

  for (const [userId, stamps, side] of [
    [referral.refereeUserId, rules.refereeStamps, "referee"],
    [referral.referrerUserId, rules.referrerStamps, "referrer"],
  ] as const) {
    if (stamps === 0) continue;
    const ledger = await LoyaltyLedger.forUser(tx, userId, rules, now);
    await ledger.credit(stamps, {
      kind: "earn",
      source: "system",
      idempotencyKey: `referral:${referral.id}:${side}`,
      details: { referral: side },
    });
    await ledger.save();
  }
  await tx
    .update(referrals)
    .set({ status: "rewarded", rewardedAt: now, orderId: order.id })
    .where(eq(referrals.id, referral.id));
  await recordAudit(tx, {
    actorUserId: null,
    action: "loyalty.referral_rewarded",
    entityType: "referral",
    entityId: referral.id,
    metadata: { referrerStamps: rules.referrerStamps, refereeStamps: rules.refereeStamps },
  });
}
