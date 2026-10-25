import { asc, desc, eq, orderItems, orderStatusEvents, orders, type Database } from "@ssc/db";
import { customerCanCancel, customerCanModify, type OrderStatus } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";
import { notFound } from "../../errors";
import { resolveOrderAccess } from "./order-access";

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

/**
 * One order with items and status history, for its owner, staff (orders:read_all) or a guest
 * holding the order's tracking token. Unknown/foreign orders and wrong tokens all return 404.
 */
export async function getOrderDetail(
  db: Database,
  actor: Actor | null,
  id: string,
  guestToken?: string | null,
  now = new Date(),
) {
  const access = await resolveOrderAccess(db, actor, id, guestToken);
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, access.order.id),
    with: {
      items: { orderBy: [asc(orderItems.createdAt)] },
      statusEvents: { orderBy: [asc(orderStatusEvents.createdAt)] },
    },
  });
  if (!order) throw notFound("Order");
  const customerView = access.via !== "staff";
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    version: order.version,
    fulfilment: order.fulfilment,
    scheduledFor: order.scheduledFor,
    readyBy:
      order.scheduledFor ??
      new Date((order.pricingSnapshot as { readyAt?: string }).readyAt ?? order.placedAt),
    placedAt: order.placedAt,
    paidAt: order.paidAt,
    completedAt: order.completedAt,
    expiresAt: order.status === "awaiting_payment" ? order.expiresAt : null,
    locale: order.locale,
    isDemo: order.isDemo,
    customerName: order.guestName,
    notes: order.notes,
    cancellationReason: order.cancellationReason,
    deliveryAddress: order.deliveryAddress as {
      line1: string;
      line2?: string;
      city: string;
      postalCode: string;
    } | null,
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
      notes: i.notes,
    })),
    timeline: order.statusEvents.map((e) => ({ status: e.toStatus, at: e.createdAt })),
    /** What the viewer may do now (customer policies). */
    canCancel: customerView && customerCanCancel(order.status),
    canModify: customerView && customerCanModify(order, now),
    updatedAt: order.updatedAt,
  };
}
export type OrderDetail = Awaited<ReturnType<typeof getOrderDetail>>;

/** Lightweight status for live tracking (polled). */
export async function getOrderStatus(
  db: Database,
  actor: Actor | null,
  id: string,
  guestToken?: string | null,
) {
  const detail = await getOrderDetail(db, actor, id, guestToken);
  return {
    id: detail.id,
    number: detail.number,
    status: detail.status,
    version: detail.version,
    timeline: detail.timeline,
    updatedAt: detail.updatedAt,
  };
}
