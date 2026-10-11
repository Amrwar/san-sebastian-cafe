import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * Append-only record of privileged actions (role changes, refunds, loyalty adjustments, price
 * changes). `metadata` must never contain secrets or payment data. IPs are stored hashed.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    metadata: jsonb().notNull().default({}),
    requestId: text(),
    ipHash: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);
