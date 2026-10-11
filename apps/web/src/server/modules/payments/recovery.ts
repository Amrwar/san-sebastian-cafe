import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  orders,
  paymentAttempts,
  refunds,
  type Database,
} from "@ssc/db";
import { LIVE_ATTEMPT_STATUSES } from "@ssc/domain";
import { logger } from "../../logger";
import { expireStaleOrders } from "../ordering/lifecycle";
import { applyCheckout } from "./checkout";
import { paymentProvider } from "./provider";
import { settleRefund, submitRefund } from "./refunds";

export interface RecoverySummary {
  checkoutsChecked: number;
  ordersExpired: number;
  checkoutsClosed: number;
  refundsSubmitted: number;
  refundsChecked: number;
  errors: number;
}

const BATCH = 50;

/**
 * Payment recovery, run by the scheduled job (GET /api/cron/payments) and safe to run any time
 * or concurrently — every step is idempotent:
 *  1. checkouts open for a while: ask the provider (a webhook may have been missed);
 *  2. expire unpaid orders whose hold has passed;
 *  3. close payment pages of orders no longer awaiting payment (money arriving later is refunded);
 *  4. resubmit refunds whose provider call never completed (same idempotency key → no double);
 *  5. re-check refunds the provider reported as pending.
 */
export async function runPaymentRecovery(db: Database, now = new Date()): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    checkoutsChecked: 0,
    ordersExpired: 0,
    checkoutsClosed: 0,
    refundsSubmitted: 0,
    refundsChecked: 0,
    errors: 0,
  };
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (error) {
      summary.errors++;
      logger().warn({ err: error, what }, "payment recovery step failed");
      return false;
    }
  };

  // 1. Live checkouts older than 2 minutes.
  const live = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.status, [...LIVE_ATTEMPT_STATUSES]),
        ne(paymentAttempts.provider, "fake"),
        lt(paymentAttempts.createdAt, minutesAgo(2)),
      ),
    )
    .limit(BATCH);
  for (const a of live) {
    if (
      await attempt(`checkout ${a.id}`, async () => {
        const snapshot = await paymentProvider(a.provider).getCheckout(a.providerSessionId);
        await applyCheckout(db, a.provider, snapshot, now);
      })
    )
      summary.checkoutsChecked++;
  }

  // 2. Unpaid orders past their hold.
  summary.ordersExpired = await db.transaction((tx) => expireStaleOrders(tx, now));

  // 3. Open payment pages of orders that can no longer be paid.
  const orphaned = await db
    .select({ attempt: paymentAttempts })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(and(eq(paymentAttempts.status, "open"), ne(orders.status, "awaiting_payment")))
    .limit(BATCH);
  for (const { attempt: a } of orphaned) {
    if (
      await attempt(`close ${a.id}`, async () => {
        if (a.provider !== "fake") {
          try {
            await paymentProvider(a.provider).expireCheckout(a.providerSessionId);
          } catch {
            // Already completed or expired at the provider: the status check below settles it.
            const snapshot = await paymentProvider(a.provider).getCheckout(a.providerSessionId);
            await applyCheckout(db, a.provider, snapshot, now);
            return;
          }
        }
        await db
          .update(paymentAttempts)
          .set({ status: "cancelled", lastError: "order_not_awaiting_payment" })
          .where(and(eq(paymentAttempts.id, a.id), eq(paymentAttempts.status, "open")));
      })
    )
      summary.checkoutsClosed++;
  }

  // 4. Refunds recorded but never accepted by the provider.
  const unsent = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, "pending"),
        isNull(refunds.providerRefundId),
        lt(refunds.createdAt, minutesAgo(1)),
      ),
    )
    .limit(BATCH);
  for (const r of unsent) {
    if (await attempt(`refund ${r.id}`, () => submitRefund(db, r.id, now)))
      summary.refundsSubmitted++;
  }

  // 5. Refunds still pending at the provider.
  const waiting = await db.query.refunds.findMany({
    where: and(
      eq(refunds.status, "pending"),
      isNotNull(refunds.providerRefundId),
      lt(refunds.updatedAt, minutesAgo(10)),
    ),
    with: { payment: true },
    limit: BATCH,
  });
  for (const r of waiting) {
    if (!r.payment || !r.providerRefundId) continue;
    const providerRefundId = r.providerRefundId;
    const provider = r.payment.provider;
    if (
      await attempt(`refund status ${r.id}`, async () => {
        const snapshot = await paymentProvider(provider).getRefund(providerRefundId);
        await settleRefund(db, { ...snapshot, localRefundId: r.id }, now);
      })
    )
      summary.refundsChecked++;
  }

  return summary;
}
