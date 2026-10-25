import { and, gte, inArray, isNull, orders, sql, type Database } from "@ssc/db";
import type { OrderStatus } from "@ssc/domain";
import { recordAudit } from "../../audit";
import { earnForOrder } from "./earning";
import { currentRules } from "./program";

/*
 * Guest-order stamp claim (ACC-2, decision D11). Someone who paid as a guest and then creates an
 * account with the same email address, within the program's `guestClaimDays`, gets those orders:
 * they appear in the account's history and earn their stamps, as if placed signed in. The address
 * is verified by the sign-in code, so the orders are theirs.
 *
 * Orders that were stopped or refunded earn nothing and stay as they are. With "earn on completion",
 * an order still in the kitchen earns when it is completed, like any account order.
 */

const CLAIMABLE: OrderStatus[] = ["paid", "accepted", "in_preparation", "ready", "completed"];
const DAY_MS = 86_400_000;

export interface ClaimResult {
  orders: number;
  stamps: number;
}

export async function claimGuestOrders(
  db: Database,
  userId: string,
  email: string,
  now = new Date(),
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const rules = await currentRules(tx);
    if (rules.guestClaimDays === 0) return { orders: 0, stamps: 0 };
    const since = new Date(now.getTime() - rules.guestClaimDays * DAY_MS);
    const claimable = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          isNull(orders.userId),
          sql`lower(${orders.guestEmail}) = lower(${email})`,
          inArray(orders.status, CLAIMABLE),
          gte(orders.paidAt, since),
        ),
      )
      .for("update");
    if (claimable.length === 0) return { orders: 0, stamps: 0 };

    const claimed = await tx
      .update(orders)
      .set({ userId, updatedAt: now })
      .where(
        inArray(
          orders.id,
          claimable.map((o) => o.id),
        ),
      )
      .returning();
    let stamps = 0;
    for (const order of claimed) {
      const earnsNow = rules.earnOn === "paid" || order.status === "completed";
      // Idempotent per order: a stamp is never given twice for the same purchase.
      if (earnsNow) stamps += await earnForOrder(tx, order, now);
    }
    await recordAudit(tx, {
      actorUserId: userId,
      action: "loyalty.guest_orders_claimed",
      entityType: "account",
      entityId: userId,
      metadata: { orders: claimed.length, stamps },
    });
    return { orders: claimed.length, stamps };
  });
}
