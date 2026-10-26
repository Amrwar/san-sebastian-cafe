import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  modifierGroups,
  modifierOptions,
  orderItems,
  orders,
  products,
  storeSettings,
  type Database,
} from "@ssc/db";
import { allowedTransitions, KITCHEN_STATUSES, type OrderStatus } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound, unprocessable } from "../../errors";
import { getStockAlerts } from "../inventory/stock";
import { expireStaleOrders } from "./lifecycle";

export interface QueueOrder {
  id: string;
  number: string;
  status: OrderStatus;
  version: number;
  customerName: string | null;
  fulfilment: "pickup" | "delivery";
  /** When the order should be ready (scheduled time or ASAP estimate), UTC ISO. */
  readyBy: string;
  scheduled: boolean;
  placedAt: string;
  notes: string | null;
  staffNotes: string | null;
  isDemo: boolean;
  items: Array<{
    id: string;
    quantity: number;
    nameFr: string;
    nameEn: string;
    variantFr: string;
    variantEn: string;
    modifiersFr: string[];
    modifiersEn: string[];
    notes: string | null;
  }>;
  /** Status changes this staff member may make right now (drives the buttons). */
  actions: OrderStatus[];
}

/**
 * Live kitchen queue: paid → accepted → in preparation → ready, oldest due first, plus the last
 * completed orders for reference. Unpaid orders are not shown (they may never be paid).
 */
export async function getStaffQueue(db: Database, actor: Actor | null, now = new Date()) {
  authorize(actor, "staff_console:access");
  await db.transaction((tx) => expireStaleOrders(tx, now));
  const [active, recent, settings, stockAlerts] = await Promise.all([
    db.query.orders.findMany({
      where: inArray(orders.status, [...KITCHEN_STATUSES]),
      orderBy: [asc(orders.placedAt)],
      with: { items: { orderBy: [asc(orderItems.createdAt)] } },
      limit: 200,
    }),
    db.query.orders.findMany({
      where: and(
        eq(orders.status, "completed"),
        gte(orders.completedAt, new Date(now.getTime() - 2 * 3600_000)),
      ),
      orderBy: [desc(orders.completedAt)],
      with: { items: { orderBy: [asc(orderItems.createdAt)] } },
      limit: 10,
    }),
    db.query.storeSettings.findFirst(),
    getStockAlerts(db),
  ]);

  const staff = { kind: "staff" as const, role: actor.role };
  const toQueue = (o: (typeof active)[number]): QueueOrder => ({
    id: o.id,
    number: o.number,
    status: o.status,
    version: o.version,
    customerName: o.guestName,
    fulfilment: o.fulfilment,
    readyBy: (
      o.scheduledFor ?? new Date((o.pricingSnapshot as { readyAt?: string }).readyAt ?? o.placedAt)
    ).toISOString(),
    scheduled: o.scheduledFor !== null,
    placedAt: o.placedAt.toISOString(),
    notes: o.notes,
    staffNotes: o.staffNotes,
    isDemo: o.isDemo,
    items: o.items.map((i) => ({
      id: i.id,
      quantity: i.quantity,
      nameFr: i.productNameFr,
      nameEn: i.productNameEn,
      variantFr: i.variantNameFr,
      variantEn: i.variantNameEn,
      modifiersFr: i.modifiers.map((m) => m.nameFr),
      modifiersEn: i.modifiers.map((m) => m.nameEn),
      notes: i.notes,
    })),
    actions: allowedTransitions({ status: o.status, paid: o.paidAt !== null }, staff).filter(
      (s) => s !== "refunded" && s !== "partially_refunded",
    ),
  });

  return {
    serverTime: now.toISOString(),
    pausedUntil:
      settings?.pausedUntil && settings.pausedUntil > now
        ? settings.pausedUntil.toISOString()
        : null,
    orders: active.map(toQueue).sort((a, b) => a.readyBy.localeCompare(b.readyBy)),
    recentlyCompleted: recent.map(toQueue),
    /** Counted items that are low or out, so the counter sees them mid-rush. */
    stockAlerts,
  };
}
export type StaffQueue = Awaited<ReturnType<typeof getStaffQueue>>;

export const pauseInput = z.object({
  /** Minutes to pause online ordering; 0 resumes immediately. */
  minutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
});

export async function setOrderingPause(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
) {
  authorize(actor, "store:pause_ordering");
  const parsed = pauseInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const pausedUntil =
    parsed.data.minutes === 0 ? null : new Date(now.getTime() + parsed.data.minutes * 60_000);
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(storeSettings)
      .set({ pausedUntil })
      .where(eq(storeSettings.id, 1))
      .returning();
    if (updated.length === 0) throw unprocessable("store_not_configured");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: pausedUntil ? "store.ordering_paused" : "store.ordering_resumed",
      entityType: "store",
      metadata: { minutes: parsed.data.minutes },
    });
    return { pausedUntil: pausedUntil?.toISOString() ?? null };
  });
}

export const availabilityInput = z.object({
  target: z.enum(["product", "option"]),
  id: z.uuid(),
  /** available: back on sale · sold_out: until manually restored · disabled_for: N minutes */
  state: z.enum(["available", "sold_out", "disabled_for"]),
  minutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
});

/** "86" a product or option (sold out, or disabled for a while), or put it back on sale. */
export async function setItemAvailability(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
) {
  authorize(actor, "catalog:toggle_availability");
  const parsed = availabilityInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;
  const values =
    input.state === "available"
      ? { availability: "available" as const, unavailableUntil: null }
      : input.state === "sold_out"
        ? { availability: "sold_out" as const, unavailableUntil: null }
        : {
            availability: "available" as const,
            unavailableUntil: new Date(now.getTime() + (input.minutes ?? 60) * 60_000),
          };

  return db.transaction(async (tx) => {
    const updated =
      input.target === "product"
        ? await tx
            .update(products)
            .set(values)
            .where(eq(products.id, input.id))
            .returning({ id: products.id })
        : await tx
            .update(modifierOptions)
            .set(values)
            .where(eq(modifierOptions.id, input.id))
            .returning({ id: modifierOptions.id });
    if (updated.length === 0) throw notFound(input.target === "product" ? "Product" : "Option");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: `catalog.${input.target}_availability_changed`,
      entityType: input.target,
      entityId: input.id,
      metadata: { state: input.state, until: values.unavailableUntil?.toISOString() ?? null },
    });
    return {
      id: input.id,
      ...values,
      unavailableUntil: values.unavailableUntil?.toISOString() ?? null,
    };
  });
}

/** Products and options with their sale state and stock, for the staff availability screen. */
export async function getAvailabilityBoard(db: Database, actor: Actor | null) {
  authorize(actor, "catalog:toggle_availability");
  const [productRows, optionRows] = await Promise.all([
    db
      .select({
        id: products.id,
        nameFr: products.nameFr,
        nameEn: products.nameEn,
        availability: products.availability,
        unavailableUntil: products.unavailableUntil,
        stockQuantity: products.stockQuantity,
        lowStockThreshold: products.lowStockThreshold,
      })
      .from(products)
      .where(isNull(products.archivedAt))
      .orderBy(asc(products.sortOrder)),
    db
      .select({
        id: modifierOptions.id,
        nameFr: modifierOptions.nameFr,
        nameEn: modifierOptions.nameEn,
        groupFr: modifierGroups.nameFr,
        groupEn: modifierGroups.nameEn,
        availability: modifierOptions.availability,
        unavailableUntil: modifierOptions.unavailableUntil,
        stockQuantity: modifierOptions.stockQuantity,
        lowStockThreshold: modifierOptions.lowStockThreshold,
      })
      .from(modifierOptions)
      .innerJoin(modifierGroups, eq(modifierGroups.id, modifierOptions.groupId))
      .where(and(isNull(modifierOptions.archivedAt), isNull(modifierGroups.archivedAt)))
      .orderBy(asc(modifierGroups.nameFr), asc(modifierOptions.sortOrder)),
  ]);
  return { products: productRows, options: optionRows };
}
