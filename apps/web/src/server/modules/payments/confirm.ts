import { eq, paymentEvents, payments, type Database } from "@ssc/db";
import type { OrderStatus, PaymentProviderName } from "@ssc/domain";
import { loadStoreConfig } from "../store/pickup";
import { applyTransition, lockOrder, recordOrderEvent } from "../ordering/lifecycle";

export interface PaymentOutcome {
  provider: PaymentProviderName;
  /** Provider's unique event id — the idempotency key for this notification. */
  eventId: string;
  orderId: string;
  providerPaymentId: string;
  amountCents: number;
  outcome: "succeeded" | "failed";
  cardBrand?: string;
  cardLast4?: string;
}

export interface PaymentResult {
  duplicate: boolean;
  status: OrderStatus;
}

/**
 * The ONLY way an order becomes paid. Called by the provider's verified webhook (Phase 6) and by
 * the development simulator. Idempotent: each provider event is processed once (unique inbox
 * row); events for orders that are no longer awaiting payment are recorded but change nothing;
 * an amount that doesn't match the order total never marks it paid.
 */
export async function recordPaymentOutcome(
  db: Database,
  outcome: PaymentOutcome,
  now = new Date(),
): Promise<PaymentResult> {
  return db.transaction(async (tx) => {
    const [inbox] = await tx
      .insert(paymentEvents)
      .values({
        provider: outcome.provider,
        eventId: outcome.eventId,
        type: outcome.outcome === "succeeded" ? "payment.succeeded" : "payment.failed",
        payload: {
          orderId: outcome.orderId,
          amountCents: outcome.amountCents,
          providerPaymentId: outcome.providerPaymentId,
        },
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });

    const order = await lockOrder(tx, outcome.orderId);
    if (!inbox) return { duplicate: true, status: order?.status ?? "awaiting_payment" };
    const markProcessed = (error?: string) =>
      tx
        .update(paymentEvents)
        .set({ processedAt: now, error: error ?? null })
        .where(eq(paymentEvents.id, inbox.id));
    if (!order) {
      await markProcessed("order_not_found");
      return { duplicate: false, status: "awaiting_payment" };
    }

    const system = { kind: "system" as const };
    if (outcome.outcome === "failed") {
      await recordOrderEvent(tx, order.id, "payment_failed", system, {
        provider: outcome.provider,
      });
      await markProcessed();
      return { duplicate: false, status: order.status };
    }
    if (order.status !== "awaiting_payment") {
      // e.g. paid after the order expired: recorded for reconciliation; Phase 6 refunds it.
      await recordOrderEvent(tx, order.id, "payment_recorded", system, {
        ignored: true,
        orderStatus: order.status,
      });
      await markProcessed("order_not_awaiting_payment");
      return { duplicate: false, status: order.status };
    }
    if (outcome.amountCents !== order.totalCents) {
      await recordOrderEvent(tx, order.id, "payment_failed", system, { reason: "amount_mismatch" });
      await markProcessed("amount_mismatch");
      return { duplicate: false, status: order.status };
    }

    await tx
      .insert(payments)
      .values({
        orderId: order.id,
        provider: outcome.provider,
        providerPaymentId: outcome.providerPaymentId,
        status: "succeeded",
        amountCents: outcome.amountCents,
        cardBrand: outcome.cardBrand ?? null,
        cardLast4: outcome.cardLast4 ?? null,
        succeededAt: now,
      })
      .onConflictDoNothing();
    await recordOrderEvent(tx, order.id, "payment_recorded", system, {
      provider: outcome.provider,
      amountCents: outcome.amountCents,
    });
    let updated = await applyTransition(tx, order, "paid", system, { now });

    const config = await loadStoreConfig(tx);
    if (config.settings.autoAccept)
      updated = await applyTransition(tx, updated, "accepted", system, { now });
    await markProcessed();
    return { duplicate: false, status: updated.status };
  });
}
