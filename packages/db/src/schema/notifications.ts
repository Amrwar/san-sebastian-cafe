import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { users } from "./identity";
import { orders } from "./ordering";

/*
 * Notifications. Messages are written to an outbox in the same transaction as the event that
 * causes them, so an event can't happen without its message being queued, and a unique
 * `dedupe_key` (event + channel) means it is queued once. A worker then sends them, with retries.
 */

export const OUTBOX_CHANNELS = ["email", "push"] as const;
export const OUTBOX_STATUSES = ["pending", "sending", "sent", "failed", "skipped"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    channel: text().notNull(),
    /** Message kind, e.g. "order_ready" (the template). */
    template: text().notNull(),
    /** Email address, or the user id whose devices receive a push. */
    recipient: text().notNull(),
    locale: text().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: "cascade" }),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** One message per event and channel. */
    dedupeKey: text().notNull().unique(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    /** Not sent before this instant (retries back off). */
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A worker holds the message until then; past it, another worker may take it over. */
    lockedUntil: timestamp({ withTimezone: true }),
    lastError: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("outbox_messages_due_idx").on(t.status, t.nextAttemptAt),
    index("outbox_messages_order_idx").on(t.orderId),
    check("outbox_messages_channel", sql`${t.channel} in (${list(OUTBOX_CHANNELS)})`),
    check("outbox_messages_status", sql`${t.status} in (${list(OUTBOX_STATUSES)})`),
    check("outbox_messages_attempts", sql`${t.attempts} >= 0`),
  ],
);

/** A browser or device a customer allowed to receive Web Push notifications. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    lastSuccessAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);
