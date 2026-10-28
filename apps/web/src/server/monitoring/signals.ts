import "server-only";
import { and, eq, gte, inArray, monitorSignals, outboxMessages, sql, type Database } from "@ssc/db";
import { appliedMigrations, EXPECTED_MIGRATIONS } from "@ssc/db/schema-version";
import { sendAlert, type AlertLevel } from "./alerts";
import { JOB_SCHEDULE, listJobRuns, type JobName } from "./jobs";

/*
 * Operational signals: the few facts that say whether the café can take and fulfil orders.
 * Each is ok, warn (degraded, someone should look today) or fail (customers are affected now).
 * The monitor job compares them with the last known state and alerts only on a change.
 */

export type SignalStatus = AlertLevel;

export interface Signal {
  /** Stable key, e.g. "schema" or "job:outbox". */
  signal: string;
  status: SignalStatus;
  /** One line a person can act on; counts and durations only. */
  detail: string;
}

/** Notifications waiting this long mean the sender isn't running. */
export const NOTIFICATION_DELAY = { warnMin: 10, failMin: 30 };
const SCHEDULED_JOBS: JobName[] = ["outbox", "payments", "retention"];

export async function collectSignals(
  db: Database,
  { now = new Date(), jobsScheduled }: { now?: Date; jobsScheduled: boolean },
): Promise<Signal[]> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [applied, [backlog], [failed], runs] = await Promise.all([
    appliedMigrations(db),
    db
      .select({
        pending: sql<number>`count(*)::int`,
        oldestMinutes: sql<
          number | null
        >`floor(extract(epoch from (${now.toISOString()}::timestamptz - min(${outboxMessages.nextAttemptAt}))) / 60)::int`,
      })
      .from(outboxMessages)
      .where(inArray(outboxMessages.status, ["pending", "sending"])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxMessages)
      .where(and(eq(outboxMessages.status, "failed"), gte(outboxMessages.updatedAt, dayAgo))),
    listJobRuns(db),
  ]);

  const signals: Signal[] = [];
  signals.push(
    applied >= EXPECTED_MIGRATIONS
      ? { signal: "schema", status: "ok", detail: `migrations ${applied}/${EXPECTED_MIGRATIONS}` }
      : {
          signal: "schema",
          status: "fail",
          detail: `database behind the code: ${applied} of ${EXPECTED_MIGRATIONS} migrations applied (run db:migrate)`,
        },
  );

  const waiting = Math.max(0, backlog?.oldestMinutes ?? 0);
  const pending = backlog?.pending ?? 0;
  signals.push({
    signal: "notifications",
    status:
      pending > 0 && waiting >= NOTIFICATION_DELAY.failMin
        ? "fail"
        : pending > 0 && waiting >= NOTIFICATION_DELAY.warnMin
          ? "warn"
          : "ok",
    detail: pending === 0 ? "nothing waiting" : `${pending} waiting, oldest ${waiting} min`,
  });

  const failedCount = failed?.n ?? 0;
  signals.push({
    signal: "notification-failures",
    status: failedCount > 0 ? "warn" : "ok",
    detail:
      failedCount > 0
        ? `${failedCount} notification(s) gave up in the last 24 h (check the email settings)`
        : "none in the last 24 h",
  });

  // Without a scheduler secret the jobs are switched off on purpose: nothing to watch.
  if (jobsScheduled) {
    for (const job of SCHEDULED_JOBS) {
      const run = runs.find((r) => r.job === job);
      const { warnAfterMin, failAfterMin } = JOB_SCHEDULE[job];
      const key = `job:${job}`;
      if (!run?.lastStartedAt) {
        signals.push({
          signal: key,
          status: "warn",
          detail: "has never run (is the scheduler set up?)",
        });
        continue;
      }
      const lastOk = run.lastSucceededAt?.getTime() ?? 0;
      const failedLast = run.lastFailedAt !== null && run.lastFailedAt.getTime() > lastOk;
      const sinceStart = Math.floor((now.getTime() - run.lastStartedAt.getTime()) / 60_000);
      if (sinceStart >= failAfterMin)
        signals.push({ signal: key, status: "fail", detail: `last ran ${sinceStart} min ago` });
      else if (failedLast)
        signals.push({
          signal: key,
          status: "fail",
          detail: `last run failed: ${run.lastError ?? "unknown error"}`,
        });
      else if (sinceStart >= warnAfterMin)
        signals.push({ signal: key, status: "warn", detail: `last ran ${sinceStart} min ago` });
      else signals.push({ signal: key, status: "ok", detail: `last ran ${sinceStart} min ago` });
    }
  }
  return signals;
}

/** The worst status among the signals. */
export function overallStatus(signals: Signal[]): SignalStatus {
  if (signals.some((s) => s.status === "fail")) return "fail";
  if (signals.some((s) => s.status === "warn")) return "warn";
  return "ok";
}

export interface MonitorRun {
  status: SignalStatus;
  changed: string[];
  alerted: number;
}

/**
 * Compares the signals with their last known state, stores the new state and sends one alert
 * per change: a signal going bad, changing severity, or recovering. A signal seen for the first
 * time alerts only if it is already bad. A problem whose alert didn't get through (webhook
 * down) is retried on the next run, without resetting how long it has lasted.
 */
export async function runMonitor(
  db: Database,
  signals: Signal[],
  { now = new Date(), alert = sendAlert }: { now?: Date; alert?: typeof sendAlert } = {},
): Promise<MonitorRun> {
  const known = new Map(
    (await db.select().from(monitorSignals)).map((row) => [row.signal, row] as const),
  );
  const changed: string[] = [];
  let alerted = 0;
  for (const s of signals) {
    const before = known.get(s.signal);
    const unchanged = before?.status === s.status;
    const unannounced = s.status !== "ok" && before?.notifiedAt == null;
    if (unchanged && !unannounced) continue;
    if (!unchanged) changed.push(s.signal);
    const recovering = s.status === "ok";
    // A recovery is announced only after a problem; a signal first seen healthy is silent.
    const shouldAlert = recovering ? before !== undefined : true;
    const sent = shouldAlert
      ? await alert({
          level: s.status,
          title: recovering
            ? `Recovered: ${s.signal}`
            : `${s.status === "fail" ? "Problem" : "Warning"}: ${s.signal}`,
          lines: [s.detail],
        })
      : false;
    if (sent) alerted++;
    const notifiedAt = sent && !recovering ? now : null;
    const since = before?.status === s.status ? before.since : now;
    await db
      .insert(monitorSignals)
      .values({ signal: s.signal, status: s.status, since, notifiedAt })
      .onConflictDoUpdate({
        target: monitorSignals.signal,
        set: { status: s.status, since, notifiedAt },
      });
  }
  return { status: overallStatus(signals), changed, alerted };
}
