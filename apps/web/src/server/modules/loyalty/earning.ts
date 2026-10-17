import {
  and,
  eq,
  loyaltyTransactions,
  orderItems,
  type orders,
  refunds,
  rewardRedemptions,
  type Tx,
} from "@ssc/db";
import { stampsForPurchase, type EarnLine } from "@ssc/domain";
import { required } from "../../errors";
import type { CountedLine, LedgerDetails, ReversalCause } from "./details";
import { activeRedemptions, LoyaltyLedger, releaseReservations } from "./ledger";
import { currentRules } from "./program";

/*
 * Loyalty effects of the order lifecycle, called by applyTransition and refund settlement inside
 * their transaction (the order row is already locked). Qualification is decided here, from the
 * order lines the server priced and snapshotted — never from anything the client sends.
 */

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;

const name = (fr: string, en: string) => ({ fr, en });

function rewardedItemId(order: OrderRow): string | null {
  return (
    (order.pricingSnapshot as { rewardedOrderItemId?: string | null }).rewardedOrderItemId ?? null
  );
}

async function itemsOf(tx: Tx, orderId: string): Promise<ItemRow[]> {
  return tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

/**
 * Earns stamps for a paid (or completed, per program) order: one per qualifying drink unit that
 * was actually paid for. Idempotent per order (`earn:order:<id>`), so a repeated webhook or a
 * second reconciliation path earns nothing more.
 */
export async function earnForOrder(tx: Tx, order: OrderRow, now: Date): Promise<number> {
  if (!order.userId) return 0;
  const rules = await currentRules(tx);
  const items = await itemsOf(tx, order.id);
  const rewarded = rewardedItemId(order);
  const lines: EarnLine[] = items.map((i) => ({
    id: i.id,
    productId: i.productId,
    variantId: i.variantId,
    quantity: i.quantity,
    isDrink: i.isDrink,
    loyaltyQualifying: i.loyaltyQualifying,
    paidCents: i.lineTotalCents - i.discountCents - i.rewardDiscountCents,
    freeUnits: i.id === rewarded ? 1 : 0,
  }));
  const result = stampsForPurchase(lines, rules);
  if (result.total === 0) return 0;

  const byId = new Map(items.map((i) => [i.id, i]));
  const details: LedgerDetails = {
    orderNumber: order.number,
    lines: result.lines
      .filter((l) => l.stamps > 0)
      .map((l) => {
        const i = required(byId.get(l.id), "order item");
        return {
          orderItemId: i.id,
          name: name(i.productNameFr, i.productNameEn),
          size: name(i.variantNameFr, i.variantNameEn),
          quantity: i.quantity,
          stamps: l.stamps,
        };
      }),
    notCounted: result.lines.flatMap((l) => {
      const i = required(byId.get(l.id), "order item");
      return l.notCounted
        .filter((n) => n.reason !== "not_qualifying" || i.isDrink)
        .map((n) => ({ name: name(i.productNameFr, i.productNameEn), ...n }));
    }),
  };

  const ledger = await LoyaltyLedger.forUser(tx, order.userId, rules, now);
  await ledger.credit(result.total, {
    kind: "earn",
    source: "online_order",
    idempotencyKey: `earn:order:${order.id}`,
    orderId: order.id,
    details,
  });
  await ledger.save();
  return result.total;
}

/**
 * Stamps earned per order line that have not been reversed yet. Works for Phase 3 entries (one per
 * line, linked by order_item_id) and current ones (one per order, lines in details).
 */
async function remainingByItem(tx: Tx, orderId: string): Promise<Map<string, number>> {
  const entries = await tx
    .select({
      kind: loyaltyTransactions.kind,
      stamps: loyaltyTransactions.stamps,
      orderItemId: loyaltyTransactions.orderItemId,
      details: loyaltyTransactions.details,
    })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.orderId, orderId));
  const remaining = new Map<string, number>();
  const add = (id: string, n: number) => remaining.set(id, (remaining.get(id) ?? 0) + n);
  for (const e of entries) {
    const lines = (e.details as LedgerDetails).lines;
    if (e.kind === "earn") {
      if (lines) for (const l of lines) add(l.orderItemId ?? "", l.stamps);
      else if (e.orderItemId) add(e.orderItemId, e.stamps);
    } else if (e.kind === "reverse") {
      if (lines) for (const l of lines) add(l.orderItemId ?? "", -l.stamps);
      else if (e.orderItemId) add(e.orderItemId, e.stamps); // legacy: stamps already negative
    }
  }
  return remaining;
}

async function reverseLines(
  tx: Tx,
  order: OrderRow,
  wanted: Map<string, number>,
  entry: {
    idempotencyKey: string;
    cause: ReversalCause;
    refundId?: string;
    actorUserId?: string | null;
  },
  now: Date,
): Promise<number> {
  if (!order.userId) return 0;
  const remaining = await remainingByItem(tx, order.id);
  const items = new Map((await itemsOf(tx, order.id)).map((i) => [i.id, i]));
  const lines: CountedLine[] = [];
  for (const [itemId, qty] of wanted) {
    const take = Math.min(qty, remaining.get(itemId) ?? 0);
    const item = items.get(itemId);
    if (take <= 0 || !item) continue;
    lines.push({
      orderItemId: itemId,
      name: name(item.productNameFr, item.productNameEn),
      size: name(item.variantNameFr, item.variantNameEn),
      quantity: qty,
      stamps: take,
    });
  }
  const total = lines.reduce((s, l) => s + l.stamps, 0);
  if (total === 0) return 0;
  const rules = await currentRules(tx);
  const ledger = await LoyaltyLedger.forUser(tx, order.userId, rules, now);
  await ledger.reverse(total, {
    source: "online_order",
    idempotencyKey: entry.idempotencyKey,
    orderId: order.id,
    refundId: entry.refundId ?? null,
    actorUserId: entry.actorUserId ?? null,
    details: { orderNumber: order.number, cause: entry.cause, lines },
  });
  await ledger.save();
  return total;
}

/** Takes back every stamp the order still holds (cancellation, rejection, full refund). */
export async function reverseOrder(
  tx: Tx,
  order: OrderRow,
  cause: Exclude<ReversalCause, "in_store_void">,
  now: Date,
): Promise<number> {
  const remaining = await remainingByItem(tx, order.id);
  return reverseLines(
    tx,
    order,
    remaining,
    { idempotencyKey: `reverse:order:${order.id}`, cause },
    now,
  );
}

/** Takes back the stamps of the order lines a successful partial refund paid back. */
export async function reverseForRefund(
  tx: Tx,
  order: OrderRow,
  refundId: string,
  now: Date,
): Promise<number> {
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
  if (!refund || refund.items.length === 0) return 0;
  const wanted = new Map<string, number>();
  for (const i of refund.items)
    wanted.set(i.orderItemId, (wanted.get(i.orderItemId) ?? 0) + i.quantity);
  return reverseLines(
    tx,
    order,
    wanted,
    {
      idempotencyKey: `reverse:refund:${refundId}`,
      cause: "refund",
      refundId,
      actorUserId: refund.requestedByUserId,
    },
    now,
  );
}

/** Payment confirmed: the reserved free drink is now used. */
export async function commitRedemptions(tx: Tx, order: OrderRow, now: Date): Promise<void> {
  const active = (await activeRedemptions(tx, order.id)).filter((r) => r.status === "reserved");
  if (active.length === 0 || !order.userId) return;
  const rules = await currentRules(tx);
  const ledger = await LoyaltyLedger.forUser(tx, order.userId, rules, now);
  const items = await itemsOf(tx, order.id);
  const rewarded = items.find((i) => i.id === rewardedItemId(order));
  for (const r of active) {
    await tx
      .update(rewardRedemptions)
      .set({ status: "committed" })
      .where(eq(rewardRedemptions.id, r.id));
    await ledger.recordRedemption(r.id, r.rewardId, {
      source: "online_order",
      orderId: order.id,
      details: {
        orderNumber: order.number,
        ...(rewarded ? { drink: name(rewarded.productNameFr, rewarded.productNameEn) } : {}),
      },
    });
  }
  await ledger.save();
}

/** Gives back the free drink used on an order that was cancelled or refunded. */
export async function reinstateRedemptions(
  tx: Tx,
  order: OrderRow,
  cause: Exclude<ReversalCause, "in_store_void">,
  now: Date,
): Promise<void> {
  await releaseReservations(tx, order.id, now);
  const committed = (await activeRedemptions(tx, order.id)).filter((r) => r.status === "committed");
  if (committed.length === 0 || !order.userId) return;
  const rules = await currentRules(tx);
  if (cause === "refund" && rules.rewardOnRefund === "keep_redeemed") return;
  const ledger = await LoyaltyLedger.forUser(tx, order.userId, rules, now);
  for (const r of committed) {
    await ledger.reinstate(r.id, r.rewardId, {
      source: "online_order",
      orderId: order.id,
      details: { orderNumber: order.number, cause },
    });
  }
  await ledger.save();
}

/** Units of each order line already covered by refunds that have not failed. */
export async function refundedUnits(tx: Tx, orderId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ items: refunds.items, status: refunds.status })
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId)));
  const units = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "failed" || r.status === "cancelled") continue;
    for (const i of r.items) units.set(i.orderItemId, (units.get(i.orderItemId) ?? 0) + i.quantity);
  }
  return units;
}
