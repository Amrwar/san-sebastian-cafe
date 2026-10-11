import { timingSafeEqual } from "node:crypto";
import { eq, orders, type Database, type Tx } from "@ssc/db";
import { can } from "@ssc/domain";
import { z } from "zod";
import type { Actor } from "../../authz";
import { notFound } from "../../errors";
import { hashToken } from "./place-order";

export type OrderRow = typeof orders.$inferSelect;

export interface OrderAccess {
  order: OrderRow;
  /** How access was granted: the signed-in owner, staff, or a guest's tracking token. */
  via: "owner" | "staff" | "guest_token";
}

function tokenMatches(order: OrderRow, token: string | null | undefined): boolean {
  if (!token || !order.guestAccessTokenHash) return false;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(order.guestAccessTokenHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolves who may see/act on an order. Unknown ids, other customers' orders and wrong tokens
 * all return the same 404 so order ids can't be probed.
 */
export async function resolveOrderAccess(
  db: Database | Tx,
  actor: Actor | null,
  orderId: string,
  guestToken?: string | null,
): Promise<OrderAccess> {
  if (!z.uuid().safeParse(orderId).success) throw notFound("Order");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
  if (actor && order.userId === actor.userId) return { order, via: "owner" };
  if (actor && can(actor.role, "orders:read_all")) return { order, via: "staff" };
  if (!order.userId && tokenMatches(order, guestToken)) return { order, via: "guest_token" };
  throw notFound("Order");
}
