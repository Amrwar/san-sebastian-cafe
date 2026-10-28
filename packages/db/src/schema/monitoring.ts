import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/*
 * Monitoring. Each scheduled job records its last run, so a job that silently stops (a scheduler
 * misconfigured, a secret rotated on one side only) shows up as overdue. The monitor job keeps
 * the last known state of each signal, so it alerts once when something goes wrong and once when
 * it recovers, not every few minutes. Counts and short error texts only; never personal data.
 */

export const JOB_NAMES = ["outbox", "payments", "retention", "monitor"] as const;
export const SIGNAL_STATUSES = ["ok", "warn", "fail"] as const;

export const jobRuns = pgTable(
  "job_runs",
  {
    job: text().primaryKey(),
    lastStartedAt: timestamp({ withTimezone: true }),
    lastSucceededAt: timestamp({ withTimezone: true }),
    lastFailedAt: timestamp({ withTimezone: true }),
    /** Short, scrubbed error text of the last failure. */
    lastError: text(),
    runs: integer().notNull().default(0),
    failures: integer().notNull().default(0),
  },
  (t) => [
    check("job_runs_job", sql`${t.job} in (${sql.raw(JOB_NAMES.map((j) => `'${j}'`).join(", "))})`),
  ],
);

export const monitorSignals = pgTable(
  "monitor_signals",
  {
    signal: text().primaryKey(),
    status: text().notNull(),
    /** Since when the signal has had this status. */
    since: timestamp({ withTimezone: true }).notNull(),
    /** Last alert sent for this signal (null: none sent for the current status). */
    notifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      "monitor_signals_status",
      sql`${t.status} in (${sql.raw(SIGNAL_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
  ],
);
