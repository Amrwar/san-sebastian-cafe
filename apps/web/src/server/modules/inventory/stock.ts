import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  modifierOptions,
  or,
  orders,
  products,
  sql,
  stockMovements,
  users,
  type CatalogProduct,
  type Database,
  type StockMovementReason,
  type Tx,
} from "@ssc/db";
import { stockDemand, stockLevel, type StockLine } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound, unprocessable } from "../../errors";

/*
 * Inventory writes. Counts live on products and options (`stock_quantity`, null = not tracked);
 * every change is written to stock_movements in the same transaction. Placing an order takes its
 * stock with a guarded decrement (never below zero, even with concurrent orders); stopping it
 * before preparation gives back exactly what it still holds.
 */

type Target = "product" | "option";
const table = (target: Target) => (target === "product" ? products : modifierOptions);
const item = (target: Target, id: string) =>
  target === "product" ? { productId: id } : { optionId: id };

/**
 * Takes the stock an order uses, inside the order's transaction. Only items the catalog tracks
 * are touched; a count that ran out since the quote throws 422 `insufficient_stock` (the whole
 * order is rolled back). Items are taken in id order so concurrent orders can't deadlock.
 */
export async function takeStock(
  tx: Tx,
  orderId: string,
  lines: readonly StockLine[],
  catalog: ReadonlyMap<string, CatalogProduct>,
  actorUserId: string | null,
): Promise<void> {
  const tracked = new Set<string>();
  for (const p of catalog.values()) {
    if (p.stock != null) tracked.add(p.id);
    for (const g of p.groups) for (const o of g.options) if (o.stock != null) tracked.add(o.id);
  }
  const demand = stockDemand(lines);
  const takes: Array<[Target, string, number]> = [
    ...[...demand.products].map(([id, n]): [Target, string, number] => ["product", id, n]),
    ...[...demand.options].map(([id, n]): [Target, string, number] => ["option", id, n]),
  ]
    .filter(([, id]) => tracked.has(id))
    .sort((a, b) => a[1].localeCompare(b[1]));

  for (const [target, id, n] of takes) {
    const t = table(target);
    const [row] = await tx
      .update(t)
      .set({ stockQuantity: sql`${t.stockQuantity} - ${n}` })
      .where(and(eq(t.id, id), isNotNull(t.stockQuantity), gte(t.stockQuantity, n)))
      .returning({ left: t.stockQuantity });
    if (!row) throw unprocessable("insufficient_stock", "An item ran out while ordering");
    await tx.insert(stockMovements).values({
      ...item(target, id),
      delta: -n,
      quantityAfter: row.left,
      reason: "sale",
      orderId,
      actorUserId,
    });
  }
}

/**
 * Gives back what an order still holds (its sales minus earlier releases), inside the caller's
 * transaction on the locked order. Safe to call twice: the second call finds nothing held.
 */
export async function releaseStock(
  tx: Tx,
  orderId: string,
  actorUserId: string | null,
): Promise<void> {
  const held = await tx
    .select({
      productId: stockMovements.productId,
      optionId: stockMovements.optionId,
      units: sql<number>`(-sum(${stockMovements.delta}))::int`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.orderId, orderId))
    .groupBy(stockMovements.productId, stockMovements.optionId)
    .having(sql`sum(${stockMovements.delta}) < 0`);

  for (const h of held) {
    const target: Target = h.productId ? "product" : "option";
    const id = h.productId ?? h.optionId;
    if (!id) continue; // impossible: a movement names exactly one item
    const t = table(target);
    // If tracking was turned off meanwhile, the count stays untracked; the ledger still closes.
    const [row] = await tx
      .update(t)
      .set({ stockQuantity: sql`${t.stockQuantity} + ${h.units}` })
      .where(and(eq(t.id, id), isNotNull(t.stockQuantity)))
      .returning({ left: t.stockQuantity });
    await tx.insert(stockMovements).values({
      ...item(target, id),
      delta: h.units,
      quantityAfter: row?.left ?? null,
      reason: "release",
      orderId,
      actorUserId,
    });
  }
}

export const stockInput = z.object({
  target: z.enum(["product", "option"]),
  id: z.uuid(),
  /** Units on hand now; null stops tracking (always on sale unless 86'd by hand). */
  quantity: z.number().int().min(0).max(100_000).nullable(),
  /** Warn staff at or under this many units; null = no warning; omitted = unchanged. */
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
});

/** Staff count: sets (or stops tracking) an item's stock. Recorded in the ledger and audit log. */
export async function setStock(db: Database, actor: Actor | null, raw: unknown) {
  authorize(actor, "catalog:toggle_availability");
  const parsed = stockInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const { target, id, quantity } = parsed.data;
  const t = table(target);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ quantity: t.stockQuantity, threshold: t.lowStockThreshold })
      .from(t)
      .where(eq(t.id, id))
      .for("update");
    if (!current) throw notFound(target === "product" ? "Product" : "Option");
    const threshold =
      parsed.data.lowStockThreshold === undefined
        ? current.threshold
        : parsed.data.lowStockThreshold;
    await tx
      .update(t)
      .set({ stockQuantity: quantity, lowStockThreshold: threshold })
      .where(eq(t.id, id));

    // The ledger records counts; a threshold change alone is only audited.
    const delta = (quantity ?? 0) - (current.quantity ?? 0);
    const reason: StockMovementReason = delta > 0 ? "restock" : "adjustment";
    if (delta !== 0 || current.quantity !== quantity) {
      await tx.insert(stockMovements).values({
        ...item(target, id),
        delta,
        quantityAfter: quantity,
        reason,
        actorUserId: actor.userId,
      });
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: `catalog.${target}_stock_set`,
      entityType: target,
      entityId: id,
      metadata: {
        from: current.quantity,
        to: quantity,
        thresholdFrom: current.threshold,
        thresholdTo: threshold,
      },
    });
    return { id, stockQuantity: quantity, lowStockThreshold: threshold };
  });
}

export interface StockAlert {
  target: Target;
  id: string;
  nameFr: string;
  nameEn: string;
  stock: number;
  level: "low" | "out";
}

/** Counted items that are out or at/under their alert threshold, out first, then fewest left. */
export async function getStockAlerts(db: Database | Tx): Promise<StockAlert[]> {
  const alerting = (t: typeof products | typeof modifierOptions) =>
    and(
      isNotNull(t.stockQuantity),
      isNull(t.archivedAt),
      or(lte(t.stockQuantity, 0), lte(t.stockQuantity, t.lowStockThreshold)),
    );
  const pick = {
    id: true,
    nameFr: true,
    nameEn: true,
    stockQuantity: true,
    lowStockThreshold: true,
  } as const;
  const [productRows, optionRows] = await Promise.all([
    db.query.products.findMany({ where: alerting(products), columns: pick }),
    db.query.modifierOptions.findMany({ where: alerting(modifierOptions), columns: pick }),
  ]);
  const toAlert =
    (target: Target) =>
    (r: (typeof productRows)[number]): StockAlert => ({
      target,
      id: r.id,
      nameFr: r.nameFr,
      nameEn: r.nameEn,
      stock: r.stockQuantity ?? 0,
      level:
        stockLevel({ stock: r.stockQuantity, lowStockThreshold: r.lowStockThreshold }) === "out"
          ? "out"
          : "low",
    });
  return [...productRows.map(toAlert("product")), ...optionRows.map(toAlert("option"))].sort(
    (a, b) => a.stock - b.stock || a.nameFr.localeCompare(b.nameFr),
  );
}

export const historyInput = z.object({
  target: z.enum(["product", "option"]),
  id: z.uuid(),
});

/** The latest stock movements of one item, with the order number and who made the change. */
export async function getStockHistory(db: Database, actor: Actor | null, raw: unknown) {
  authorize(actor, "catalog:toggle_availability");
  const parsed = historyInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const { target, id } = parsed.data;
  const rows = await db
    .select({
      id: stockMovements.id,
      reason: stockMovements.reason,
      delta: stockMovements.delta,
      quantityAfter: stockMovements.quantityAfter,
      createdAt: stockMovements.createdAt,
      orderNumber: orders.number,
      actorName: users.name,
    })
    .from(stockMovements)
    .leftJoin(orders, eq(orders.id, stockMovements.orderId))
    .leftJoin(users, eq(users.id, stockMovements.actorUserId))
    .where(
      target === "product" ? eq(stockMovements.productId, id) : eq(stockMovements.optionId, id),
    )
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(50);
  return rows.map((r) => ({
    ...r,
    // Staff names only: a customer's name stays off the stock screen.
    actorName: r.orderNumber ? null : r.actorName,
    createdAt: r.createdAt.toISOString(),
  }));
}
