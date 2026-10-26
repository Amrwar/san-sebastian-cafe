import {
  and,
  categories,
  desc,
  eq,
  inArray,
  isNotNull,
  not,
  orders,
  products,
  promotions,
  sql,
  type Database,
} from "@ssc/db";
import { CAFE_TIME_ZONE, PROMOTION_KINDS, PROMOTION_SCOPES, zonedToUtc } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";
import { addDays } from "../reports/range";

/*
 * Promotions administration (manager and above). A promotion is never deleted: orders that used
 * it point to it and keep their own discount amounts, so editing or ending one never changes an
 * order already placed. It is switched off instead. Every change is audited.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
const isUuid = (id: string) => z.uuid().safeParse(id).success;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalCount = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

/** Start of a café date (00:00 in Montréal). */
function startOfDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return zonedToUtc(y ?? 1970, m ?? 1, d ?? 1, 0);
}
/** End of a café date: the start of the next day (DST-safe). */
const endOfDay = (date: string) => startOfDay(addDays(date, 1));

export const promotionInput = z
  .object({
    /** What customers type: letters, digits and dashes (stored in capitals). */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,32}$/),
    nameFr: z.string().trim().min(2).max(80),
    nameEn: z.string().trim().min(2).max(80),
    kind: z.enum(PROMOTION_KINDS),
    /** percent_off: basis points (1000 = 10 %); amount_off: cents. */
    value: z.number().int().min(1).max(100_000),
    scope: z.enum(PROMOTION_SCOPES),
    targetIds: z.array(z.uuid()).max(100),
    minSubtotalCents: z.number().int().min(0).max(100_000),
    startsOn: day,
    endsOn: day.nullish().transform((v) => v ?? null),
    maxRedemptions: optionalCount(1_000_000),
    maxRedemptionsPerCustomer: optionalCount(1000),
    stackableWithRewards: z.boolean(),
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.kind === "percent_off" && p.value > 10_000)
      ctx.addIssue({ code: "custom", path: ["value"], message: "at most 100 %" });
    if (p.scope === "order" && p.targetIds.length > 0)
      ctx.addIssue({ code: "custom", path: ["targetIds"], message: "order-wide" });
    if (p.scope !== "order" && p.targetIds.length === 0)
      ctx.addIssue({ code: "custom", path: ["targetIds"], message: "choose items" });
    if (p.endsOn && p.endsOn < p.startsOn)
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "before start" });
  });
export type PromotionInput = z.infer<typeof promotionInput>;

/** Orders that count as having used a promotion: paid and not stopped or refunded. */
const USED = and(
  isNotNull(orders.paidAt),
  not(inArray(orders.status, ["cancelled", "expired", "rejected", "refunded"])),
);

export interface AdminPromotion extends PromotionInput {
  id: string;
  isDemo: boolean;
  uses: number;
  discountGivenCents: number;
  state: "active" | "scheduled" | "ended" | "off";
}

const toDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: CAFE_TIME_ZONE }).format(d);

export async function listAdminPromotions(
  db: Database,
  actor: Actor | null,
  now = new Date(),
): Promise<AdminPromotion[]> {
  authorize(actor, "promotions:manage");
  const [rows, usage] = await Promise.all([
    db.select().from(promotions).orderBy(desc(promotions.isActive), desc(promotions.startsAt)),
    db
      .select({
        promotionId: orders.promotionId,
        uses: sql<number>`count(*)::int`,
        discount: sql<number>`coalesce(sum(${orders.discountCents}), 0)::int`,
      })
      .from(orders)
      .where(and(isNotNull(orders.promotionId), USED))
      .groupBy(orders.promotionId),
  ]);
  const used = new Map(usage.map((u) => [u.promotionId, u]));
  return rows.map((p) => ({
    id: p.id,
    code: p.code ?? "",
    nameFr: p.nameFr,
    nameEn: p.nameEn,
    kind: p.kind,
    value: p.value,
    scope: p.scope,
    targetIds: p.targetIds,
    minSubtotalCents: p.minSubtotalCents,
    startsOn: toDay(p.startsAt),
    // Stored as the start of the next day; shown as the last day it applies.
    endsOn: p.endsAt ? toDay(new Date(p.endsAt.getTime() - 1)) : null,
    maxRedemptions: p.maxRedemptions,
    maxRedemptionsPerCustomer: p.maxRedemptionsPerCustomer,
    stackableWithRewards: p.stackableWithRewards,
    isActive: p.isActive,
    isDemo: p.isDemo,
    uses: used.get(p.id)?.uses ?? 0,
    discountGivenCents: used.get(p.id)?.discount ?? 0,
    state: !p.isActive
      ? "off"
      : p.startsAt > now
        ? "scheduled"
        : p.endsAt && p.endsAt <= now
          ? "ended"
          : "active",
  }));
}

/** Creates (no id) or edits a promotion. */
export async function savePromotion(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  promotionId?: string,
): Promise<{ id: string }> {
  authorize(actor, "promotions:manage");
  const input = parse(promotionInput, raw);
  if (promotionId !== undefined && !isUuid(promotionId)) throw notFound("Promotion");

  return db.transaction(async (tx) => {
    // Targets must be current products or categories.
    if (input.targetIds.length > 0) {
      const table = input.scope === "product" ? products : categories;
      const found = await tx
        .select({ id: table.id })
        .from(table)
        .where(inArray(table.id, input.targetIds));
      if (found.length !== new Set(input.targetIds).size)
        throw new AppError("validation_failed", "Unknown item", [
          { path: "targetIds", code: "unknown_id" },
        ]);
    }
    const [clash] = await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(sql`lower(${promotions.code}) = lower(${input.code})`);
    if (clash && clash.id !== promotionId)
      throw new AppError("conflict", "Code already used", [], "code_taken");

    const values = {
      code: input.code,
      nameFr: input.nameFr,
      nameEn: input.nameEn,
      kind: input.kind,
      value: input.value,
      scope: input.scope,
      targetIds: input.targetIds,
      minSubtotalCents: input.minSubtotalCents,
      startsAt: startOfDay(input.startsOn),
      endsAt: input.endsOn ? endOfDay(input.endsOn) : null,
      maxRedemptions: input.maxRedemptions,
      maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer,
      stackableWithRewards: input.stackableWithRewards,
      isActive: input.isActive,
    };

    if (promotionId === undefined) {
      const [row] = await tx.insert(promotions).values(values).returning({ id: promotions.id });
      const id = row?.id ?? "";
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "promotion.created",
        entityType: "promotion",
        entityId: id,
        metadata: { code: input.code, kind: input.kind, value: input.value },
      });
      return { id };
    }
    const [before] = await tx
      .select()
      .from(promotions)
      .where(eq(promotions.id, promotionId))
      .for("update");
    if (!before) throw notFound("Promotion");
    const changed = (Object.keys(values) as Array<keyof typeof values>).filter((k) => {
      const a = before[k];
      const b = values[k];
      if (a instanceof Date || b instanceof Date)
        return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    await tx
      .update(promotions)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(promotions.id, promotionId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "promotion.updated",
      entityType: "promotion",
      entityId: promotionId,
      metadata: { code: input.code, changed },
    });
    return { id: promotionId };
  });
}
