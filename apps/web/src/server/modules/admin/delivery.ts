import { and, asc, deliveryZones, eq, isNotNull, orders, sql, type Database } from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";

/*
 * Delivery zones (manager and above). Delivery is offered at checkout only while at least one
 * zone is switched on. A zone lists the postal-code prefixes it serves (the first three
 * characters, e.g. "H2T"), its fee, the minimum order and the usual travel time. Zones are never
 * deleted (orders point to them); they are switched off instead. Every change is audited.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** A Canadian forward sortation area: letter, digit, letter (the first half of a postal code). */
const FSA = /^[ABCEGHJ-NPRSTVXY]\d[A-Z]$/;

export const deliveryZoneInput = z
  .object({
    nameFr: z.string().trim().min(2).max(80),
    nameEn: z.string().trim().min(2).max(80),
    /** Typed "H2T, H2V h2s": capitals, no spaces, duplicates removed. */
    postalPrefixes: z
      .array(z.string().trim().toUpperCase().regex(FSA))
      .min(1)
      .max(50)
      .transform((list) => [...new Set(list)]),
    feeCents: z.number().int().min(0).max(5_000),
    minimumOrderCents: z.number().int().min(0).max(20_000),
    estimatedMinutes: z.number().int().min(5).max(180),
    isActive: z.boolean(),
  })
  .strict();
export type DeliveryZoneInput = z.infer<typeof deliveryZoneInput>;

export interface AdminDeliveryZone extends DeliveryZoneInput {
  id: string;
  isDemo: boolean;
  /** Paid delivery orders sent to this zone. */
  orders: number;
}

export async function listDeliveryZones(
  db: Database,
  actor: Actor | null,
): Promise<AdminDeliveryZone[]> {
  authorize(actor, "store:configure");
  const [zones, usage] = await Promise.all([
    db.select().from(deliveryZones).orderBy(asc(deliveryZones.nameFr)),
    db
      .select({ zoneId: orders.deliveryZoneId, n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(isNotNull(orders.deliveryZoneId), isNotNull(orders.paidAt)))
      .groupBy(orders.deliveryZoneId),
  ]);
  const counts = new Map(usage.map((u) => [u.zoneId, u.n]));
  return zones.map((z) => ({
    id: z.id,
    nameFr: z.nameFr,
    nameEn: z.nameEn,
    postalPrefixes: z.postalPrefixes,
    feeCents: z.feeCents,
    minimumOrderCents: z.minimumOrderCents,
    estimatedMinutes: z.estimatedMinutes,
    isActive: z.isActive,
    isDemo: z.isDemo,
    orders: counts.get(z.id) ?? 0,
  }));
}

/**
 * Creates (no id) or edits a zone. Two zones that are on can't serve the same prefix: a customer's
 * fee would depend on which one the database returned first.
 */
export async function saveDeliveryZone(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  zoneId?: string,
): Promise<{ id: string }> {
  authorize(actor, "store:configure");
  const input = parse(deliveryZoneInput, raw);
  if (zoneId !== undefined && !isUuid(zoneId)) throw notFound("Delivery zone");

  return db.transaction(async (tx) => {
    // One change to the zones at a time, so two edits can't both pass the overlap check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('delivery_zones'))`);
    if (input.isActive) {
      const others = await tx
        .select({ id: deliveryZones.id, prefixes: deliveryZones.postalPrefixes })
        .from(deliveryZones)
        .where(eq(deliveryZones.isActive, true));
      const taken = others
        .filter((o) => o.id !== zoneId)
        .flatMap((o) => o.prefixes.map((p) => p.toUpperCase()))
        .filter((p) => input.postalPrefixes.includes(p));
      if (taken.length > 0)
        throw new AppError(
          "conflict",
          `Already served by another zone: ${taken.join(", ")}`,
          [{ path: "postalPrefixes", code: "taken" }],
          "prefix_taken",
        );
    }

    const values = {
      nameFr: input.nameFr,
      nameEn: input.nameEn,
      postalPrefixes: input.postalPrefixes,
      feeCents: input.feeCents,
      minimumOrderCents: input.minimumOrderCents,
      estimatedMinutes: input.estimatedMinutes,
      isActive: input.isActive,
    };
    const metadata = {
      postalPrefixes: input.postalPrefixes,
      feeCents: input.feeCents,
      minimumOrderCents: input.minimumOrderCents,
      isActive: input.isActive,
    };

    if (zoneId === undefined) {
      const [row] = await tx
        .insert(deliveryZones)
        .values(values)
        .returning({ id: deliveryZones.id });
      const id = row?.id ?? "";
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "delivery_zone.created",
        entityType: "delivery_zone",
        entityId: id,
        metadata,
      });
      return { id };
    }
    const [before] = await tx
      .select()
      .from(deliveryZones)
      .where(eq(deliveryZones.id, zoneId))
      .for("update");
    if (!before) throw notFound("Delivery zone");
    const changed = (Object.keys(values) as Array<keyof typeof values>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(values[k]),
    );
    await tx
      .update(deliveryZones)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(deliveryZones.id, zoneId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "delivery_zone.updated",
      entityType: "delivery_zone",
      entityId: zoneId,
      metadata: { ...metadata, changed },
    });
    return { id: zoneId };
  });
}
