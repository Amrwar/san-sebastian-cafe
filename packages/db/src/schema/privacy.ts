import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { users } from "./identity";

/*
 * Privacy module (Québec Law 25). Requests from people about their personal information, and the
 * register of confidentiality incidents the law requires the café to keep.
 */

export const PRIVACY_REQUEST_KINDS = [
  "access",
  "export",
  "rectification",
  "deletion",
  "withdrawal",
  "other",
] as const;
export const PRIVACY_REQUEST_CHANNELS = [
  "self_service",
  "email",
  "phone",
  "in_person",
  "mail",
] as const;
export const PRIVACY_REQUEST_STATUSES = ["open", "completed", "refused"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * A request about someone's personal information: access, a copy, a correction, deletion, the
 * withdrawal of a consent… The law gives 30 days to answer, so `dueAt` is set on receipt.
 * Self-service exports and deletions are recorded here automatically, already completed.
 */
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    channel: text().notNull(),
    status: text().notNull().default("open"),
    /** The account concerned, when there is one (cleared if the account is deleted). */
    subjectUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** How to reach the requester (email or phone), for requests not made from an account. */
    subjectContact: text(),
    details: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    completedAt: timestamp({ withTimezone: true }),
    /** What was done, or why the request was refused. */
    outcome: text(),
    handledByUserId: text().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("privacy_requests_status_idx").on(t.status, t.dueAt),
    index("privacy_requests_subject_idx").on(t.subjectUserId),
    check("privacy_requests_kind", sql`${t.kind} in (${list(PRIVACY_REQUEST_KINDS)})`),
    check("privacy_requests_channel", sql`${t.channel} in (${list(PRIVACY_REQUEST_CHANNELS)})`),
    check("privacy_requests_status", sql`${t.status} in (${list(PRIVACY_REQUEST_STATUSES)})`),
    check("privacy_requests_closed", sql`(${t.status} = 'open') = (${t.completedAt} is null)`),
  ],
);

export const INCIDENT_STATUSES = ["open", "closed"] as const;

/**
 * Register of confidentiality incidents (unauthorized access, use, disclosure or loss of personal
 * information). Every incident is recorded, serious or not; the law requires keeping the register
 * and reporting incidents that present a risk of serious injury to the Commission d'accès à
 * l'information and to the people concerned. Entries are corrected, never deleted.
 */
export const confidentialityIncidents = pgTable(
  "confidentiality_incidents",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** When it happened, if known. */
    occurredAt: timestamp({ withTimezone: true }),
    discoveredAt: timestamp({ withTimezone: true }).notNull(),
    description: text().notNull(),
    /** What personal information was involved (e.g. "names and emails of 12 customers"). */
    dataInvolved: text().notNull(),
    peopleAffected: integer(),
    /** Null until assessed. */
    riskOfSeriousInjury: boolean(),
    riskAssessment: text(),
    measuresTaken: text(),
    commissionNotifiedAt: timestamp({ withTimezone: true }),
    peopleNotifiedAt: timestamp({ withTimezone: true }),
    status: text().notNull().default("open"),
    closedAt: timestamp({ withTimezone: true }),
    recordedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("confidentiality_incidents_discovered_idx").on(t.discoveredAt),
    check("confidentiality_incidents_status", sql`${t.status} in (${list(INCIDENT_STATUSES)})`),
    check(
      "confidentiality_incidents_closed",
      sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`,
    ),
    check(
      "confidentiality_incidents_people",
      sql`${t.peopleAffected} is null or ${t.peopleAffected} >= 0`,
    ),
  ],
);
