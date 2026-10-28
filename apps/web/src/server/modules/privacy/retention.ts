import {
  giftCardPurchases,
  and,
  inArray,
  isNotNull,
  loyaltyCardCodes,
  lt,
  ne,
  orders,
  outboxMessages,
  paymentEvents,
  rateLimits,
  sessions,
  sql,
  verifications,
  type Database,
} from "@ssc/db";
import type { OrderStatus } from "@ssc/domain";
import { recordAudit } from "../../audit";
import { ANONYMIZED_ADDRESS, ANONYMIZED_EMAIL, ANONYMIZED_NAME, anonymizeOrders } from "./deletion";

/*
 * Retention (Law 25: keep personal information only as long as needed). Run daily by
 * /api/cron/retention. Periods are the café's policy, to confirm with counsel; financial records
 * (orders, payments, refunds) are kept for tax purposes, without contact details once these
 * periods pass.
 */
export const RETENTION = {
  /** Guest orders: name, email, phone and notes, kept for receipts, support and chargebacks. */
  guestContactDays: 365,
  /**
   * Delivery addresses (customers with an account too): a home address isn't needed once the
   * order is long finished; kept past the card-dispute window.
   */
  deliveryAddressDays: 180,
  /** Payment provider webhook payloads (they contain the payer's email and address). */
  paymentEventPayloadDays: 90,
  /** Notifications already sent (or given up): their recipient address and content. */
  outboxDays: 30,
  /** Sign-in rate-limit counters. */
  rateLimitDays: 1,
} as const;

const DAY_MS = 86_400_000;
const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);
const FINISHED: OrderStatus[] = [
  "completed",
  "cancelled",
  "expired",
  "refunded",
  "partially_refunded",
  "rejected",
];

export interface RetentionSummary {
  sessions: number;
  verifications: number;
  cardCodes: number;
  rateLimits: number;
  guestOrdersAnonymized: number;
  paymentEventsRedacted: number;
  notificationsDeleted: number;
  giftCardPurchasesAnonymized: number;
  deliveryAddressesErased: number;
}

export async function runRetention(db: Database, now = new Date()): Promise<RetentionSummary> {
  return db.transaction(async (tx) => {
    const sessionRows = await tx
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    const verificationRows = await tx
      .delete(verifications)
      .where(lt(verifications.expiresAt, now))
      .returning({ id: verifications.id });
    const codeRows = await tx
      .delete(loyaltyCardCodes)
      .where(lt(loyaltyCardCodes.expiresAt, now))
      .returning({ code: loyaltyCardCodes.code });
    const limitRows = await tx
      .delete(rateLimits)
      .where(lt(rateLimits.lastRequest, daysBefore(now, RETENTION.rateLimitDays).getTime()))
      .returning({ id: rateLimits.id });

    const oldGuestOrders = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          sql`${orders.userId} is null`,
          ne(orders.guestEmail, ANONYMIZED_EMAIL),
          inArray(orders.status, FINISHED),
          lt(orders.placedAt, daysBefore(now, RETENTION.guestContactDays)),
        ),
      )
      .for("update");
    const guestOrdersAnonymized = await anonymizeOrders(
      tx,
      oldGuestOrders.map((o) => o.id),
    );

    const addresses = await tx
      .update(orders)
      .set({ deliveryAddress: ANONYMIZED_ADDRESS, updatedAt: now })
      .where(
        and(
          isNotNull(orders.deliveryAddress),
          sql`not jsonb_exists(${orders.deliveryAddress}, 'anonymized')`,
          inArray(orders.status, FINISHED),
          lt(orders.placedAt, daysBefore(now, RETENTION.deliveryAddressDays)),
        ),
      )
      .returning({ id: orders.id });

    const redacted = await tx
      .update(paymentEvents)
      .set({ payload: { redacted: true } })
      .where(
        and(
          isNotNull(paymentEvents.processedAt),
          lt(paymentEvents.receivedAt, daysBefore(now, RETENTION.paymentEventPayloadDays)),
          sql`not jsonb_exists(${paymentEvents.payload}, 'redacted')`,
        ),
      )
      .returning({ id: paymentEvents.id });

    const notifications = await tx
      .delete(outboxMessages)
      .where(
        and(
          inArray(outboxMessages.status, ["sent", "failed", "skipped"]),
          lt(outboxMessages.updatedAt, daysBefore(now, RETENTION.outboxDays)),
        ),
      )
      .returning({ id: outboxMessages.id });

    // Gift card purchases: names, emails and the note, a year on (the card stays, it's money owed).
    const oldPurchases = await tx
      .update(giftCardPurchases)
      .set({
        purchaserName: ANONYMIZED_NAME,
        purchaserEmail: ANONYMIZED_EMAIL,
        recipientName: ANONYMIZED_NAME,
        recipientEmail: ANONYMIZED_EMAIL,
        message: null,
        purchaserUserId: null,
      })
      .where(
        and(
          ne(giftCardPurchases.status, "awaiting_payment"),
          ne(giftCardPurchases.purchaserEmail, ANONYMIZED_EMAIL),
          lt(giftCardPurchases.createdAt, daysBefore(now, RETENTION.guestContactDays)),
        ),
      )
      .returning({ id: giftCardPurchases.id });

    const summary: RetentionSummary = {
      sessions: sessionRows.length,
      verifications: verificationRows.length,
      cardCodes: codeRows.length,
      rateLimits: limitRows.length,
      guestOrdersAnonymized,
      paymentEventsRedacted: redacted.length,
      notificationsDeleted: notifications.length,
      giftCardPurchasesAnonymized: oldPurchases.length,
      deliveryAddressesErased: addresses.length,
    };
    if (guestOrdersAnonymized > 0 || redacted.length > 0 || addresses.length > 0) {
      await recordAudit(tx, {
        actorUserId: null,
        action: "privacy.retention_applied",
        entityType: "retention",
        metadata: {
          guestOrdersAnonymized,
          paymentEventsRedacted: redacted.length,
          deliveryAddressesErased: addresses.length,
        },
      });
    }
    return summary;
  });
}
