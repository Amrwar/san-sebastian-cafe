import { and, asc, desc, eq, orderItems, orderStatusEvents, orders, type Database } from "@ssc/db";
import { can, type OrderStatus } from "@ssc/domain";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { notFound } from "../../errors";

/** Statuses during which the customer is waiting for their order (shown as "in progress"). */
export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  "paid",
  "accepted",
  "in_preparation",
  "ready",
];

/** Tracking timeline steps, in order. */
export const TRACKING_STEPS = ["paid", "accepted", "in_preparation", "ready", "completed"] as const;

export interface OrderSummary {
  id: string;
  number: string;
  status: OrderStatus;
  placedAt: Date;
  totalCents: number;
  itemCount: number;
  fulfilment: "pickup" | "delivery";
  isDemo: boolean;
}

export async function listMyOrders(
  db: Database,
  actor: Actor | null,
  limit = 50,
): Promise<OrderSummary[]> {
  authorize(actor, "orders:read_own");
  const rows = await db.query.orders.findMany({
    where: eq(orders.userId, actor.userId),
    orderBy: [desc(orders.placedAt)],
    limit: Math.min(Math.max(limit, 1), 100),
    with: { items: { columns: { quantity: true } } },
  });
  return rows.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    placedAt: o.placedAt,
    totalCents: o.totalCents,
    itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
    fulfilment: o.fulfilment,
    isDemo: o.isDemo,
  }));
}

export async function findActiveOrder(
  db: Database,
  actor: Actor | null,
): Promise<OrderSummary | null> {
  if (!actor) return null;
  const all = await listMyOrders(db, actor, 10);
  return all.find((o) => ACTIVE_STATUSES.includes(o.status)) ?? null;
}

const orderId = z.uuid();

/**
 * One order with items and status history. Customers can only read their own orders; staff
 * (orders:read_all) can read any. Unknown and foreign orders both return 404, so ids cannot be probed.
 */
export async function getOrderDetail(db: Database, actor: Actor | null, id: string) {
  authorize(actor, "orders:read_own");
  if (!orderId.safeParse(id).success) throw notFound("Order");
  const order = await db.query.orders.findFirst({
    where: can(actor.role, "orders:read_all")
      ? eq(orders.id, id)
      : and(eq(orders.id, id), eq(orders.userId, actor.userId)),
    with: {
      items: { orderBy: [asc(orderItems.createdAt)] },
      statusEvents: { orderBy: [asc(orderStatusEvents.createdAt)] },
    },
  });
  if (!order) throw notFound("Order");
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    fulfilment: order.fulfilment,
    scheduledFor: order.scheduledFor,
    placedAt: order.placedAt,
    completedAt: order.completedAt,
    locale: order.locale,
    isDemo: order.isDemo,
    totals: {
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      rewardDiscountCents: order.rewardDiscountCents,
      deliveryFeeCents: order.deliveryFeeCents,
      gstCents: order.gstCents,
      qstCents: order.qstCents,
      tipCents: order.tipCents,
      totalCents: order.totalCents,
    },
    items: order.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      variantId: i.variantId,
      productNameFr: i.productNameFr,
      productNameEn: i.productNameEn,
      variantNameFr: i.variantNameFr,
      variantNameEn: i.variantNameEn,
      modifiers: i.modifiers,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      lineTotalCents: i.lineTotalCents,
    })),
    timeline: order.statusEvents.map((e) => ({ status: e.toStatus, at: e.createdAt })),
    updatedAt: order.updatedAt,
  };
}
export type OrderDetail = Awaited<ReturnType<typeof getOrderDetail>>;

/** Lightweight status for live tracking (polled). */
export async function getOrderStatus(db: Database, actor: Actor | null, id: string) {
  const detail = await getOrderDetail(db, actor, id);
  return {
    id: detail.id,
    number: detail.number,
    status: detail.status,
    timeline: detail.timeline,
    updatedAt: detail.updatedAt,
  };
}
