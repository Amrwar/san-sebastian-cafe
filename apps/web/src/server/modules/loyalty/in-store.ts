import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  loyaltyAccounts,
  loyaltyCardCodes,
  loyaltyInStoreVisits,
  productVariants,
  products,
  rewardRedemptions,
  rewards,
  sql,
  users,
  type Database,
  type InStoreVisitItem,
  type Tx,
} from "@ssc/db";
import {
  isCardCode,
  isRewardEligible,
  localParts,
  normalizeCardCode,
  rewardValueCents,
  stampsForPurchase,
  zonedToUtc,
  type EarnLine,
  type LoyaltyRules,
} from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, required, unprocessable } from "../../errors";
import type { LedgerDetails } from "./details";
import { LoyaltyLedger } from "./ledger";
import { currentRules } from "./program";

/*
 * Stamps for purchases at the counter. Staff identify the customer with the short-lived code from
 * their phone, then enter what the till receipt shows. Everything that decides the stamps (which
 * drinks qualify, prices, the free drink's value) is read here from the catalog; the receipt
 * number is unique, so one sale can't be stamped twice.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** Receipt numbers are compared without spaces, dashes or case. */
export function normalizeReceipt(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export interface InStoreCustomer {
  /** Opaque to staff: used only to submit the visit. */
  code: string;
  firstName: string;
  stampBalance: number;
  stampDebt: number;
  stampsPerReward: number;
  availableRewards: number;
}

async function userForCode(db: Database | Tx, raw: string, now: Date) {
  if (!isCardCode(raw)) throw unprocessable("card_code_invalid");
  const [row] = await db
    .select({ userId: loyaltyCardCodes.userId, name: users.name })
    .from(loyaltyCardCodes)
    .innerJoin(users, eq(users.id, loyaltyCardCodes.userId))
    .where(
      and(eq(loyaltyCardCodes.code, normalizeCardCode(raw)), gt(loyaltyCardCodes.expiresAt, now)),
    );
  if (!row) throw unprocessable("card_code_invalid");
  return row;
}

function requireInStore(rules: LoyaltyRules) {
  if (!rules.inStoreEnabled) throw unprocessable("in_store_disabled");
}

/** Who a customer's code belongs to, with the minimum a barista needs (first name, card). */
export async function lookupCardCode(
  db: Database,
  actor: Actor | null,
  raw: string,
  now = new Date(),
): Promise<InStoreCustomer> {
  authorize(actor, "loyalty:in_store");
  const rules = await currentRules(db);
  requireInStore(rules);
  const user = await userForCode(db, raw, now);
  const account = await db.query.loyaltyAccounts.findFirst({
    where: eq(loyaltyAccounts.userId, user.userId),
  });
  const available = account
    ? await db
        .select({ id: rewards.id })
        .from(rewards)
        .where(and(eq(rewards.accountId, account.id), eq(rewards.status, "available")))
    : [];
  return {
    code: normalizeCardCode(raw),
    firstName: firstName(user.name),
    stampBalance: account?.stampBalance ?? 0,
    stampDebt: account?.stampDebt ?? 0,
    stampsPerReward: rules.stampsPerReward,
    availableRewards: available.length,
  };
}

export const inStoreVisitInput = z
  .object({
    code: z.string().trim().min(1).max(20),
    receiptReference: z.string().trim().min(1).max(40),
    items: z
      .array(
        z
          .object({
            productId: z.uuid(),
            variantId: z.uuid(),
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    /** Use one available reward on an eligible drink of this purchase. */
    useReward: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(8).max(100),
  })
  .strict();

export interface InStoreVisitResult {
  visitId: string;
  stampsEarned: number;
  rewardsIssued: number;
  rewardUsed: boolean;
  stampBalance: number;
  replayed: boolean;
}

/** Start of the café's local day containing `now`. */
function localDayStart(now: Date): Date {
  const p = localParts(now);
  return zonedToUtc(p.year, p.month, p.day, 0);
}

/**
 * Records a counter purchase for the customer whose code was scanned: stamps per qualifying paid
 * drink (capped per visit and per day), optionally one free drink. Repeating the same request
 * (same idempotency key) returns the first result; reusing a receipt number is refused.
 */
export async function recordInStoreVisit(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<InStoreVisitResult> {
  authorize(actor, "loyalty:in_store");
  const input = parse(inStoreVisitInput, raw);
  const receiptReference = normalizeReceipt(input.receiptReference);
  if (!receiptReference) {
    throw new AppError("validation_failed", "Receipt number required", [
      { path: "receiptReference", code: "too_small" },
    ]);
  }

  return db.transaction(async (tx) => {
    const replay = await tx.query.loyaltyInStoreVisits.findFirst({
      where: eq(loyaltyInStoreVisits.idempotencyKey, input.idempotencyKey),
    });
    if (replay) return replayResult(tx, replay);

    const rules = await currentRules(tx);
    requireInStore(rules);
    const user = await userForCode(tx, input.code, now);
    const ledger = await LoyaltyLedger.forUser(tx, user.userId, rules, now);

    // Locked account: a concurrent submission of the same receipt waits here, then fails below.
    const [taken] = await tx
      .select({ id: loyaltyInStoreVisits.id })
      .from(loyaltyInStoreVisits)
      .where(eq(loyaltyInStoreVisits.receiptReference, receiptReference));
    if (taken) throw new AppError("conflict", "Receipt already recorded", [], "receipt_recorded");

    const items = await catalogItems(tx, input.items);

    // The free drink: the most expensive eligible unit, using the oldest available reward.
    let reward: typeof rewards.$inferSelect | undefined;
    let free: (typeof items)[number] | undefined;
    if (input.useReward) {
      [reward] = await tx
        .select()
        .from(rewards)
        .where(and(eq(rewards.accountId, ledger.account.id), eq(rewards.status, "available")))
        .orderBy(asc(rewards.issuedAt))
        .limit(1)
        .for("update");
      if (!reward || (reward.expiresAt && reward.expiresAt <= now))
        throw unprocessable("reward_unavailable");
      for (const item of items) {
        if (!isRewardEligible(item.product, item.variantId, rules)) continue;
        if (!free || item.unitPriceCents > free.unitPriceCents) free = item;
      }
      if (!free) throw unprocessable("reward_not_applicable");
    }
    // Staff enter product and size only, so the free drink is valued at its size price.
    const freeValue =
      reward && free ? rewardValueCents(free.unitPriceCents, free.unitPriceCents, reward) : 0;

    // Per-visit and per-day caps (the day is the café's local day; voided visits don't count).
    const [today] = await tx
      .select({ n: sql<number>`coalesce(sum(${loyaltyInStoreVisits.stampsEarned}), 0)::int` })
      .from(loyaltyInStoreVisits)
      .where(
        and(
          eq(loyaltyInStoreVisits.accountId, ledger.account.id),
          gte(loyaltyInStoreVisits.createdAt, localDayStart(now)),
          isNull(loyaltyInStoreVisits.voidedAt),
        ),
      );
    const cap = Math.max(
      0,
      Math.min(
        rules.inStoreMaxStampsPerVisit,
        rules.inStoreMaxStampsPerDay - (today?.n ?? 0),
        rules.maxStampsPerPurchase ?? Number.POSITIVE_INFINITY,
      ),
    );
    const lines: EarnLine[] = items.map((item, i) => ({
      id: String(i),
      productId: item.product.id,
      variantId: item.variantId,
      quantity: item.quantity,
      isDrink: item.product.isDrink,
      loyaltyQualifying: item.loyaltyQualifying,
      paidCents: item.unitPriceCents * item.quantity - (item === free ? freeValue : 0),
      freeUnits: item === free ? 1 : 0,
    }));
    const earned = stampsForPurchase(lines, { ...rules, maxStampsPerPurchase: cap });
    const results = items.map((item, i) => ({ item, ...required(earned.lines[i], "earn line") }));

    const snapshot: InStoreVisitItem[] = results.map(({ item, stamps }) => ({
      productId: item.product.id,
      variantId: item.variantId,
      nameFr: item.nameFr,
      nameEn: item.nameEn,
      variantNameFr: item.variantNameFr,
      variantNameEn: item.variantNameEn,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      isDrink: item.product.isDrink,
      loyaltyQualifying: item.loyaltyQualifying,
      freeUnits: item === free ? 1 : 0,
      stamps,
    }));
    const [visit] = await tx
      .insert(loyaltyInStoreVisits)
      .values({
        accountId: ledger.account.id,
        staffUserId: actor.userId,
        receiptReference,
        items: snapshot,
        stampsEarned: earned.total,
        programVersion: rules.version,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      })
      .returning({ id: loyaltyInStoreVisits.id });
    const visitId = required(visit, "visit").id;

    const name = (item: (typeof items)[number]) => ({ fr: item.nameFr, en: item.nameEn });
    if (reward && free) {
      const [redemption] = await tx
        .insert(rewardRedemptions)
        .values({
          rewardId: reward.id,
          inStoreVisitId: visitId,
          discountCents: freeValue,
          status: "committed",
        })
        .returning({ id: rewardRedemptions.id });
      await ledger.recordRedemption(required(redemption, "redemption").id, reward.id, {
        source: "in_store",
        inStoreVisitId: visitId,
        actorUserId: actor.userId,
        details: { receiptReference, drink: name(free) },
      });
    }
    const details: LedgerDetails = {
      receiptReference,
      lines: results
        .filter((r) => r.stamps > 0)
        .map(({ item, stamps }) => ({
          name: name(item),
          size: { fr: item.variantNameFr, en: item.variantNameEn },
          quantity: item.quantity,
          stamps,
        })),
      notCounted: results.flatMap(({ item, notCounted }) =>
        notCounted
          .filter((n) => n.reason !== "not_qualifying" || item.product.isDrink)
          .map((n) => ({ name: name(item), ...n })),
      ),
    };
    const rewardsIssued = await ledger.credit(earned.total, {
      kind: "earn",
      source: "in_store",
      idempotencyKey: `earn:visit:${visitId}`,
      inStoreVisitId: visitId,
      actorUserId: actor.userId,
      details,
    });
    const state = await ledger.save();
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "loyalty.in_store_visit",
      entityType: "loyalty_in_store_visit",
      entityId: visitId,
      metadata: { receiptReference, stamps: earned.total, rewardUsed: Boolean(reward) },
    });
    return {
      visitId,
      stampsEarned: earned.total,
      rewardsIssued,
      rewardUsed: Boolean(reward),
      stampBalance: state.balance,
      replayed: false,
    };
  });
}

async function replayResult(
  tx: Tx,
  visit: typeof loyaltyInStoreVisits.$inferSelect,
): Promise<InStoreVisitResult> {
  const [account] = await tx
    .select({ stampBalance: loyaltyAccounts.stampBalance })
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.id, visit.accountId));
  return {
    visitId: visit.id,
    stampsEarned: visit.stampsEarned,
    rewardsIssued: 0,
    rewardUsed: visit.items.some((i) => i.freeUnits > 0),
    stampBalance: account?.stampBalance ?? 0,
    replayed: true,
  };
}

/** The catalog facts for what staff entered; unknown or archived items are refused. */
async function catalogItems(
  tx: Tx,
  entered: ReadonlyArray<{ productId: string; variantId: string; quantity: number }>,
) {
  const rows = await tx
    .select({ product: products, variant: productVariants })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        inArray(
          productVariants.id,
          entered.map((e) => e.variantId),
        ),
        isNull(productVariants.archivedAt),
      ),
    );
  const byVariant = new Map(rows.map((r) => [r.variant.id, r]));
  return entered.map((e, i) => {
    const row = byVariant.get(e.variantId);
    if (!row || row.product.id !== e.productId || row.product.archivedAt) {
      throw new AppError("validation_failed", "Unknown product", [
        { path: `items.${i}.variantId`, code: "unknown_id" },
      ]);
    }
    return {
      product: {
        id: row.product.id,
        isDrink: row.product.isDrink,
        rewardEligible: row.product.rewardEligible,
      },
      loyaltyQualifying: row.product.loyaltyQualifying,
      variantId: row.variant.id,
      nameFr: row.product.nameFr,
      nameEn: row.product.nameEn,
      variantNameFr: row.variant.nameFr,
      variantNameEn: row.variant.nameEn,
      unitPriceCents: row.variant.priceCents,
      quantity: e.quantity,
    };
  });
}

export const voidVisitInput = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/**
 * Cancels a recorded visit (wrong customer, wrong receipt): its stamps are taken back under the
 * program's policy and a free drink used on it is given back. Shift lead or above; audited.
 */
export async function voidInStoreVisit(
  db: Database,
  actor: Actor | null,
  visitId: string,
  raw: unknown,
  now = new Date(),
): Promise<{ stampBalance: number; stampDebt: number }> {
  authorize(actor, "loyalty:adjust");
  const { reason } = parse(voidVisitInput, raw);
  if (!z.uuid().safeParse(visitId).success) throw notFound("Visit");

  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select()
      .from(loyaltyInStoreVisits)
      .where(eq(loyaltyInStoreVisits.id, visitId));
    if (!visit) throw notFound("Visit");
    const rules = await currentRules(tx);
    const ledger = required(
      await LoyaltyLedger.forAccount(tx, visit.accountId, rules, now),
      "loyalty account",
    );
    // Re-read under the account lock so two voids can't both pass.
    const [locked] = await tx
      .select({ voidedAt: loyaltyInStoreVisits.voidedAt })
      .from(loyaltyInStoreVisits)
      .where(eq(loyaltyInStoreVisits.id, visitId));
    if (locked?.voidedAt) throw unprocessable("visit_already_voided");

    await tx
      .update(loyaltyInStoreVisits)
      .set({ voidedAt: now, voidedByUserId: actor.userId, voidReason: reason })
      .where(eq(loyaltyInStoreVisits.id, visitId));
    await ledger.reverse(visit.stampsEarned, {
      source: "in_store",
      idempotencyKey: `reverse:visit:${visitId}`,
      inStoreVisitId: visitId,
      actorUserId: actor.userId,
      reason,
      details: { receiptReference: visit.receiptReference, cause: "in_store_void" },
    });
    const used = await tx
      .select({ id: rewardRedemptions.id, rewardId: rewardRedemptions.rewardId })
      .from(rewardRedemptions)
      .where(
        and(
          eq(rewardRedemptions.inStoreVisitId, visitId),
          eq(rewardRedemptions.status, "committed"),
        ),
      );
    for (const r of used) {
      await ledger.reinstate(r.id, r.rewardId, {
        source: "in_store",
        inStoreVisitId: visitId,
        actorUserId: actor.userId,
        details: { receiptReference: visit.receiptReference, cause: "in_store_void" },
      });
    }
    const state = await ledger.save();
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "loyalty.in_store_visit_voided",
      entityType: "loyalty_in_store_visit",
      entityId: visitId,
      metadata: { reason, stamps: visit.stampsEarned, rewardReinstated: used.length > 0 },
    });
    return { stampBalance: state.balance, stampDebt: state.debt };
  });
}

export interface InStoreCatalogProduct {
  id: string;
  nameFr: string;
  nameEn: string;
  isDrink: boolean;
  loyaltyQualifying: boolean;
  variants: Array<{ id: string; nameFr: string; nameEn: string; priceCents: number }>;
}

/** What staff can pick from when entering a receipt: current products and sizes, drinks first. */
export async function inStoreCatalog(
  db: Database,
  actor: Actor | null,
): Promise<InStoreCatalogProduct[]> {
  authorize(actor, "loyalty:in_store");
  const rows = await db
    .select({ product: products, variant: productVariants })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .where(and(isNull(products.archivedAt), isNull(productVariants.archivedAt)))
    .orderBy(asc(products.nameFr), asc(productVariants.sortOrder));
  const byId = new Map<string, InStoreCatalogProduct>();
  for (const { product, variant } of rows) {
    let entry = byId.get(product.id);
    if (!entry) {
      entry = {
        id: product.id,
        nameFr: product.nameFr,
        nameEn: product.nameEn,
        isDrink: product.isDrink,
        loyaltyQualifying: product.loyaltyQualifying,
        variants: [],
      };
      byId.set(product.id, entry);
    }
    entry.variants.push({
      id: variant.id,
      nameFr: variant.nameFr,
      nameEn: variant.nameEn,
      priceCents: variant.priceCents,
    });
  }
  return [...byId.values()].sort((a, b) => Number(b.isDrink) - Number(a.isDrink));
}
