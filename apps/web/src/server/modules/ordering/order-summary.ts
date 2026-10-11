import { count, orders, type Database } from "@ssc/db";
import { ORDER_STATUSES, type OrderStatus } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";

/** Order counts per status (every status listed, zero when none). Staff only. */
export async function countOrdersByStatus(
  db: Database,
  actor: Actor | null,
): Promise<Array<{ status: OrderStatus; count: number }>> {
  authorize(actor, "orders:read_all");
  const rows = await db
    .select({ status: orders.status, count: count() })
    .from(orders)
    .groupBy(orders.status);
  const byStatus = new Map(rows.map((r) => [r.status, r.count]));
  return ORDER_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 }));
}
