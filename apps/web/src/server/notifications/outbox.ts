import {
  and,
  eq,
  inArray,
  lt,
  notificationPreferences,
  or,
  outboxMessages,
  payments,
  pushSubscriptions,
  sql,
  users,
  type Database,
  type orders,
  type Tx,
} from "@ssc/db";
import type { OrderStatus } from "@ssc/domain";
import { logger } from "../logger";
import { ANONYMIZED_EMAIL } from "../modules/privacy/deletion";

/*
 * Customer notifications through an outbox (see packages/db/src/schema/notifications.ts).
 *
 * 1. queueOrderNotifications runs inside the transaction that changes the order, so a message
 *    exists if and only if the change committed. Its dedupe key (event + channel) makes a retried
 *    or replayed change queue nothing new.
 * 2. processOutbox claims due messages (FOR UPDATE SKIP LOCKED, so two workers never take the
 *    same one), sends them, and records the result. A failure is retried with growing delays,
 *    then marked failed. If a worker dies after sending but before recording, the claim expires
 *    and the message is sent again: delivery is at least once, rarely twice, never zero.
 */

type OrderRow = typeof orders.$inferSelect;

export const NOTIFICATION_TEMPLATES = [
  "order_confirmed",
  "order_ready",
  "order_cancelled",
  "order_rejected",
  "order_refunded",
  "order_on_the_way",
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];

/** What a message needs to be written; the text itself is rendered when it is sent. */
export interface NotificationPayload {
  orderId: string;
  number: string;
  totalCents: number;
  /** Pickup time (scheduled or slot), ISO. */
  pickupAt: string | null;
  /** Whether the customer has an account (only then does the email link to the order). */
  hasAccount: boolean;
  reason?: string | null;
  refundedCents?: number;
  paid?: boolean;
  /** Delivery orders: the estimated delivery time, ISO (absent for pickup). */
  deliverBy?: string | null;
}

const EMAIL_TEMPLATES: Record<OrderStatus, NotificationTemplate | null> = {
  awaiting_payment: null,
  paid: "order_confirmed",
  accepted: null,
  in_preparation: null,
  ready: "order_ready",
  completed: null,
  cancelled: "order_cancelled",
  expired: null,
  rejected: "order_rejected",
  refunded: "order_refunded",
  partially_refunded: "order_refunded",
  out_for_delivery: "order_on_the_way",
};
/** Push is for what needs attention now. */
const PUSH_TEMPLATES: readonly NotificationTemplate[] = [
  "order_ready",
  "order_on_the_way",
  "order_cancelled",
  "order_rejected",
];

/** Queues the customer's messages for an order status change (caller's transaction). */
export async function queueOrderNotifications(
  tx: Tx,
  before: OrderRow,
  after: OrderRow,
  now: Date,
): Promise<void> {
  const to = after.status;
  const template = EMAIL_TEMPLATES[to];
  if (!template) return;
  // A delivery order waiting for its courier is not "ready at the counter": its notice is
  // "on the way", sent when it leaves.
  if (template === "order_ready" && after.fulfilment === "delivery") return;
  // A cancelled order's refund was already announced with the cancellation.
  if (
    template === "order_refunded" &&
    (before.status === "cancelled" || before.status === "rejected")
  )
    return;

  const payload: NotificationPayload = {
    orderId: after.id,
    number: after.number,
    totalCents: after.totalCents,
    pickupAt: (after.scheduledFor ?? after.slotStart)?.toISOString() ?? null,
    hasAccount: after.userId !== null,
  };
  if (after.fulfilment === "delivery")
    payload.deliverBy = (after.pricingSnapshot as { deliverBy?: string }).deliverBy ?? null;
  let key = `${after.id}:${template}`;
  if (template === "order_cancelled" || template === "order_rejected") {
    payload.reason = after.cancellationReason;
    payload.paid = after.paidAt !== null;
  }
  if (template === "order_refunded") {
    const [payment] = await tx
      .select({ refundedCents: payments.refundedCents })
      .from(payments)
      .where(and(eq(payments.orderId, after.id), sql`${payments.reconciliation} is null`))
      .limit(1);
    payload.refundedCents = payment?.refundedCents ?? 0;
    // Each partial refund is its own message.
    key += `:${payload.refundedCents}`;
  }
  const locale = after.locale.startsWith("en") ? "en" : "fr";

  const rows: Array<typeof outboxMessages.$inferInsert> = [];
  const email = await emailRecipient(tx, after);
  if (email)
    rows.push({
      channel: "email",
      template,
      recipient: email,
      locale,
      orderId: after.id,
      payload: { ...payload },
      dedupeKey: `${key}:email`,
      nextAttemptAt: now,
    });
  if (after.userId && PUSH_TEMPLATES.includes(template)) {
    const [device] = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, after.userId))
      .limit(1);
    if (device)
      rows.push({
        channel: "push",
        template,
        recipient: after.userId,
        locale,
        orderId: after.id,
        payload: { ...payload },
        dedupeKey: `${key}:push`,
        nextAttemptAt: now,
      });
  }
  if (rows.length > 0) await tx.insert(outboxMessages).values(rows).onConflictDoNothing();
}

/** The address order emails go to, or null when the customer turned them off. */
async function emailRecipient(tx: Tx, order: OrderRow): Promise<string | null> {
  if (!order.userId)
    return order.guestEmail && order.guestEmail !== ANONYMIZED_EMAIL ? order.guestEmail : null;
  const [row] = await tx
    .select({ email: users.email, enabled: notificationPreferences.enabled })
    .from(users)
    .leftJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.userId, users.id),
        eq(notificationPreferences.channel, "email"),
        eq(notificationPreferences.topic, "order_updates"),
      ),
    )
    .where(eq(users.id, order.userId));
  // No preference row: order updates are on by default (transactional, not marketing).
  return row && row.enabled !== false ? row.email : null;
}

// --- Sending ----------------------------------------------------------------------------------

interface QueuedBase {
  id: string;
  channel: "email" | "push";
  recipient: string;
  locale: "fr" | "en";
}

/** A notice about an order. */
export interface OrderMessage extends QueuedBase {
  template: NotificationTemplate;
  payload: NotificationPayload;
}

/** A marketing email of a campaign (see modules/marketing). */
export interface MarketingPayload {
  campaignId: string;
  /** The consenting customer; null for a test sent to staff. */
  userId: string | null;
  test?: boolean;
}
export interface MarketingMessage extends QueuedBase {
  template: "marketing";
  payload: MarketingPayload;
}

/** A gift card bought on the site: the card to its recipient, or the purchaser's receipt. */
export interface GiftCardPayload {
  purchaseId: string;
  amountCents: number;
  recipientName: string;
  purchaserName: string;
  /** Delivery only, until sent: erased from the queue once the email has gone. */
  code?: string | null;
  message?: string | null;
  /** Receipt only. */
  last4?: string;
  recipientEmail?: string;
}
export interface GiftCardMessage extends QueuedBase {
  template: "gift_card_delivery" | "gift_card_receipt";
  payload: GiftCardPayload;
}

export type QueuedMessage = OrderMessage | MarketingMessage | GiftCardMessage;

/**
 * How messages leave. `send` returns "sent", or "skipped" when there was nobody left to reach
 * (e.g. every push device unsubscribed); it throws to retry later.
 */
export interface Deliverer {
  send(message: QueuedMessage): Promise<"sent" | "skipped">;
}

export const MAX_ATTEMPTS = 5;
const CLAIM_MS = 2 * 60_000;
/** 1 min, 5 min, 25 min, ~2 h between attempts. */
const backoffMs = (attempts: number) => 60_000 * 5 ** (attempts - 1);

export interface OutboxRun {
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

export async function processOutbox(
  db: Database,
  deliverer: Deliverer,
  { now = new Date(), limit = 20 }: { now?: Date; limit?: number } = {},
): Promise<OutboxRun> {
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        or(
          and(
            eq(outboxMessages.status, "pending"),
            lt(outboxMessages.nextAttemptAt, new Date(now.getTime() + 1)),
          ),
          and(eq(outboxMessages.status, "sending"), lt(outboxMessages.lockedUntil, now)),
        ),
      )
      .orderBy(outboxMessages.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(outboxMessages)
      .set({
        status: "sending",
        attempts: sql`${outboxMessages.attempts} + 1`,
        lockedUntil: new Date(now.getTime() + CLAIM_MS),
        updatedAt: now,
      })
      .where(
        inArray(
          outboxMessages.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });

  const run: OutboxRun = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (const row of claimed) {
    const message = {
      id: row.id,
      channel: row.channel,
      template: row.template,
      recipient: row.recipient,
      locale: row.locale === "en" ? "en" : "fr",
      payload: row.payload,
    } as unknown as QueuedMessage;
    try {
      const outcome = await deliverer.send(message);
      await db
        .update(outboxMessages)
        .set({
          status: outcome,
          sentAt: outcome === "sent" ? now : null,
          lockedUntil: null,
          lastError: null,
          updatedAt: now,
          // A gift card code is kept only until its email has gone.
          ...(row.template === "gift_card_delivery"
            ? { payload: { ...row.payload, code: null } }
            : {}),
        })
        .where(eq(outboxMessages.id, row.id));
      run[outcome] += 1;
    } catch (err) {
      const final = row.attempts >= MAX_ATTEMPTS;
      await db
        .update(outboxMessages)
        .set({
          status: final ? "failed" : "pending",
          nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)),
          lockedUntil: null,
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          updatedAt: now,
        })
        .where(eq(outboxMessages.id, row.id));
      logger().warn(
        { err, messageId: row.id, channel: row.channel, attempt: row.attempts },
        "notification not sent",
      );
      run[final ? "failed" : "retried"] += 1;
    }
  }
  return run;
}
