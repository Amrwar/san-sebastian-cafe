import {
  and,
  eq,
  paymentAttempts,
  paymentDisputes,
  paymentEvents,
  payments,
  type Database,
  type Tx,
} from "@ssc/db";
import type { CheckoutSnapshot, PaymentProviderName } from "@ssc/domain";
import { recordAudit } from "../../audit";
import { lockOrder, recordOrderEvent } from "../ordering/lifecycle";
import { applyCheckoutInTx, recordPaymentFailure } from "./checkout";
import {
  paymentProvider,
  type DisputeSnapshot,
  type RefundSnapshot,
  type VerifiedEvent,
} from "./provider";
import { settleRefundInTx, submitRefunds } from "./refunds";

export interface WebhookResult {
  eventId: string;
  type: string;
  duplicate: boolean;
  /** Recorded but not acted on (unknown session, event type we don't use…). */
  note: string | null;
}

/**
 * Processes one provider webhook:
 *  1. verify the signature (throws WebhookSignatureError → 400, nothing is stored);
 *  2. skip events already processed (provider retries, duplicate deliveries);
 *  3. read the current state from the provider (authenticated) — events can arrive out of order,
 *     so the latest state is applied rather than the event's snapshot;
 *  4. in ONE transaction: insert the inbox row (unique per event id) and apply the effects.
 *     If anything fails, nothing is committed and the provider's retry processes it again.
 */
export async function handlePaymentWebhook(
  db: Database,
  providerName: PaymentProviderName,
  rawBody: string,
  signature: string | null,
  now = new Date(),
): Promise<WebhookResult> {
  const provider = paymentProvider(providerName);
  const event = provider.verifyWebhook(rawBody, signature);
  const result = (duplicate: boolean, note: string | null = null): WebhookResult => ({
    eventId: event.id,
    type: event.type,
    duplicate,
    note,
  });

  const seen = await db.query.paymentEvents.findFirst({
    where: and(eq(paymentEvents.provider, providerName), eq(paymentEvents.eventId, event.id)),
  });
  if (seen?.processedAt) return result(true);

  let checkout: CheckoutSnapshot | null = null;
  let refund: RefundSnapshot | null = null;
  if (event.kind === "checkout") {
    // Only sessions this app created are ours to reconcile (not, e.g., dashboard payment links).
    const known = await db.query.paymentAttempts.findFirst({
      where: and(
        eq(paymentAttempts.provider, providerName),
        eq(paymentAttempts.providerSessionId, event.sessionId),
      ),
    });
    if (known) checkout = await provider.getCheckout(event.sessionId);
  }
  if (event.kind === "refund") refund = await provider.getRefund(event.refundId);

  const outcome = await db.transaction(async (tx) => {
    const [inbox] = await tx
      .insert(paymentEvents)
      .values({
        provider: providerName,
        eventId: event.id,
        type: event.type,
        // Ids only — no customer details are kept from provider payloads.
        payload: payloadFor(event),
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });
    if (!inbox) return { duplicate: true, note: null, refundIds: [] as string[] };

    let note: string | null = null;
    let refundIds: string[] = [];
    switch (event.kind) {
      case "checkout": {
        if (!checkout) {
          note = "unknown_session";
          break;
        }
        const applied = await applyCheckoutInTx(tx, providerName, checkout, now);
        refundIds = applied.refundIds;
        if (applied.outcome === "unknown_session") note = "unknown_session";
        break;
      }
      case "payment_failed":
        await recordPaymentFailure(tx, {
          orderId: event.orderId,
          providerPaymentId: event.paymentId,
          message: event.message,
        });
        break;
      case "refund":
        await settleRefundInTx(tx, refund as RefundSnapshot, now);
        break;
      case "dispute":
        note = await recordDispute(tx, providerName, event.dispute);
        break;
      case "ignored":
        note = "ignored_type";
        break;
    }
    await tx
      .update(paymentEvents)
      .set({ processedAt: now, error: note })
      .where(eq(paymentEvents.id, inbox.id));
    return { duplicate: false, note, refundIds };
  });

  await submitRefunds(db, outcome.refundIds, now);
  return result(outcome.duplicate, outcome.note);
}

function payloadFor(event: VerifiedEvent): Record<string, unknown> {
  switch (event.kind) {
    case "checkout":
      return { kind: event.kind, sessionId: event.sessionId };
    case "payment_failed":
      return { kind: event.kind, paymentId: event.paymentId, orderId: event.orderId };
    case "refund":
      return { kind: event.kind, refundId: event.refundId };
    case "dispute":
      return {
        kind: event.kind,
        disputeId: event.dispute.disputeId,
        paymentId: event.dispute.paymentId,
        status: event.dispute.status,
      };
    case "ignored":
      return { kind: event.kind };
  }
}

/**
 * Chargebacks: recorded (and kept current) for staff follow-up in the payments screen. A dispute
 * never changes the order — the café responds with evidence in the provider's dashboard.
 */
async function recordDispute(
  tx: Tx,
  providerName: PaymentProviderName,
  dispute: DisputeSnapshot,
): Promise<string | null> {
  const [payment] = dispute.paymentId
    ? await tx
        .select({ id: payments.id, orderId: payments.orderId })
        .from(payments)
        .where(
          and(
            eq(payments.provider, providerName),
            eq(payments.providerPaymentId, dispute.paymentId),
          ),
        )
    : [];
  if (payment) await lockOrder(tx, payment.orderId);
  await tx
    .insert(paymentDisputes)
    .values({
      provider: providerName,
      providerDisputeId: dispute.disputeId,
      paymentId: payment?.id ?? null,
      orderId: payment?.orderId ?? null,
      amountCents: dispute.amountCents,
      reason: dispute.reason,
      status: dispute.status,
      evidenceDueBy: dispute.evidenceDueBy,
    })
    .onConflictDoUpdate({
      target: [paymentDisputes.provider, paymentDisputes.providerDisputeId],
      set: {
        status: dispute.status,
        amountCents: dispute.amountCents,
        evidenceDueBy: dispute.evidenceDueBy,
      },
    });
  if (!payment) return "dispute_payment_unknown";
  await recordOrderEvent(
    tx,
    payment.orderId,
    "dispute_updated",
    { kind: "system" },
    {
      disputeId: dispute.disputeId,
      status: dispute.status,
      amountCents: dispute.amountCents,
    },
  );
  await recordAudit(tx, {
    actorUserId: null,
    action: "payment.dispute_updated",
    entityType: "order",
    entityId: payment.orderId,
    metadata: { disputeId: dispute.disputeId, status: dispute.status },
  });
  return null;
}
