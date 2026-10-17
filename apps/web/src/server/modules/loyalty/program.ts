import {
  desc,
  inArray,
  loyaltyPrograms,
  productVariants,
  products,
  sql,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  DEFAULT_LOYALTY_RULES,
  EARN_TRIGGERS,
  LOYALTY_RULE_LIMITS as L,
  REFUND_SHORTFALL_POLICIES,
  REWARD_REFUND_POLICIES,
  type LoyaltyRules,
} from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, required, unprocessable } from "../../errors";

/*
 * Loyalty program versions. The newest version applies to everything that happens from now on;
 * ledger entries and rewards record the version they were made under, so a rule change is never
 * retroactive and balances in progress are preserved.
 */

type ProgramRow = typeof loyaltyPrograms.$inferSelect;

export interface ProgramVersion extends LoyaltyRules {
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

function toRules(row: ProgramRow): ProgramVersion {
  return {
    version: row.version,
    stampsPerReward: row.stampsPerReward,
    earnOn: row.earnOn,
    minPaidCentsPerDrink: row.minPaidCentsPerDrink,
    maxStampsPerPurchase: row.maxStampsPerPurchase,
    excludedProductIds: row.excludedProductIds,
    excludedVariantIds: row.excludedVariantIds,
    rewardExcludedProductIds: row.rewardExcludedProductIds,
    rewardExcludedVariantIds: row.rewardExcludedVariantIds,
    rewardValueCapCents: row.rewardValueCapCents,
    rewardCoversModifiers: row.rewardCoversModifiers,
    rewardExpiryDays: row.rewardExpiryDays,
    refundShortfallPolicy: row.refundShortfallPolicy,
    rewardOnRefund: row.rewardOnRefund,
    inStoreEnabled: row.inStoreEnabled,
    inStoreMaxStampsPerVisit: row.inStoreMaxStampsPerVisit,
    inStoreMaxStampsPerDay: row.inStoreMaxStampsPerDay,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

/** The rules in force. Falls back to version 1 defaults if the table is empty (never in practice). */
export async function currentRules(db: Database | Tx): Promise<LoyaltyRules> {
  const [row] = await db
    .select()
    .from(loyaltyPrograms)
    .orderBy(desc(loyaltyPrograms.version))
    .limit(1);
  return row ? toRules(row) : DEFAULT_LOYALTY_RULES;
}

export async function listProgramVersions(
  db: Database,
  actor: Actor | null,
): Promise<ProgramVersion[]> {
  authorize(actor, "admin_console:access");
  const rows = await db.select().from(loyaltyPrograms).orderBy(desc(loyaltyPrograms.version));
  return rows.map(toRules);
}

const count = (min: number, max: number) => z.number().int().min(min).max(max);
const ids = z.array(z.uuid()).max(200);

export const programInput = z
  .object({
    stampsPerReward: count(L.stampsPerReward.min, L.stampsPerReward.max),
    earnOn: z.enum(EARN_TRIGGERS),
    minPaidCentsPerDrink: count(L.minPaidCentsPerDrink.min, L.minPaidCentsPerDrink.max),
    maxStampsPerPurchase: count(L.maxStampsPerPurchase.min, L.maxStampsPerPurchase.max).nullable(),
    excludedProductIds: ids,
    excludedVariantIds: ids,
    rewardExcludedProductIds: ids,
    rewardExcludedVariantIds: ids,
    rewardValueCapCents: count(L.rewardValueCapCents.min, L.rewardValueCapCents.max).nullable(),
    rewardCoversModifiers: z.boolean(),
    rewardExpiryDays: count(L.rewardExpiryDays.min, L.rewardExpiryDays.max).nullable(),
    refundShortfallPolicy: z.enum(REFUND_SHORTFALL_POLICIES),
    rewardOnRefund: z.enum(REWARD_REFUND_POLICIES),
    inStoreEnabled: z.boolean(),
    inStoreMaxStampsPerVisit: count(L.inStoreMaxStampsPerVisit.min, L.inStoreMaxStampsPerVisit.max),
    inStoreMaxStampsPerDay: count(L.inStoreMaxStampsPerDay.min, L.inStoreMaxStampsPerDay.max),
    note: z.string().trim().min(3).max(300),
  })
  .strict();
export type ProgramInput = z.infer<typeof programInput>;

const RULE_FIELDS = Object.keys(programInput.shape).filter((k) => k !== "note") as Array<
  Exclude<keyof ProgramInput, "note">
>;

const sortedList = (v: readonly unknown[]) => v.map(String).sort().join();
const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && sortedList(a) === sortedList(b)
    : a === b;

/**
 * Saves a new program version (owner only). Rejects ids that are not menu products/sizes and a
 * submission identical to the current rules. Audited with the list of changed fields.
 */
export async function saveProgramVersion(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<{ version: number }> {
  authorize(actor, "loyalty:configure");
  const parsed = programInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;

  return db.transaction(async (tx) => {
    // Serializes concurrent saves so version numbers stay gapless.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('loyalty_programs'))`);
    const current = await currentRules(tx);

    const productIds = [
      ...new Set([...input.excludedProductIds, ...input.rewardExcludedProductIds]),
    ];
    const variantIds = [
      ...new Set([...input.excludedVariantIds, ...input.rewardExcludedVariantIds]),
    ];
    const [foundProducts, foundVariants] = await Promise.all([
      productIds.length
        ? tx.select({ id: products.id }).from(products).where(inArray(products.id, productIds))
        : Promise.resolve([]),
      variantIds.length
        ? tx
            .select({ id: productVariants.id })
            .from(productVariants)
            .where(inArray(productVariants.id, variantIds))
        : Promise.resolve([]),
    ]);
    if (foundProducts.length !== productIds.length || foundVariants.length !== variantIds.length) {
      throw new AppError("validation_failed", "Unknown product or size", [
        { path: "excludedProductIds", code: "unknown_id" },
      ]);
    }

    const changed = RULE_FIELDS.filter((f) => !sameValue(input[f], current[f]));
    if (changed.length === 0) throw unprocessable("no_changes");

    const version = current.version + 1;
    const [row] = await tx
      .insert(loyaltyPrograms)
      .values({ ...input, version, createdByUserId: actor.userId })
      .returning({ version: loyaltyPrograms.version });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "loyalty.rules_changed",
      entityType: "loyalty_program",
      entityId: String(version),
      metadata: {
        from: current.version,
        changed: Object.fromEntries(changed.map((f) => [f, { from: current[f], to: input[f] }])),
      },
    });
    return { version: required(row, "program").version };
  });
}
