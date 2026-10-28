import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRuns, outboxMessages, sql, type Database, type DbHandle } from "@ssc/db";
import { createTestDatabase } from "@ssc/db/testing";
import type { Alert } from "./alerts";
import { withJobRun } from "./jobs";
import { collectSignals, runMonitor, type Signal } from "./signals";

/*
 * Monitoring against a real database: scheduled jobs record their runs, the signals turn
 * overdue jobs and stuck notifications into warnings and failures, and the monitor alerts once
 * per change (going bad, changing severity, recovering), never on every run.
 */

let handle: DbHandle;
let db: Database;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await db.execute(sql`truncate table job_runs, monitor_signals, outbox_messages`);
});

const T0 = new Date("2026-10-28T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const byKey = (signals: Signal[]) => Object.fromEntries(signals.map((s) => [s.signal, s]));

describe("job heartbeats", () => {
  it("records each run, its success or its scrubbed failure, and passes the result through", async () => {
    expect(
      await withJobRun(db, "retention", () => Promise.resolve("done"), { now: () => T0 }),
    ).toBe("done");
    await expect(
      withJobRun(
        db,
        "retention",
        () => Promise.reject(new Error("could not reach robin@example.test")),
        { now: () => at(5) },
      ),
    ).rejects.toThrow("could not reach");
    // A job that reports failure without throwing (the outbox returns null).
    await withJobRun(db, "outbox", () => Promise.resolve(null), {
      isFailure: () => true,
      now: () => T0,
    });

    const rows = Object.fromEntries((await db.select().from(jobRuns)).map((r) => [r.job, r]));
    expect(rows.retention).toMatchObject({
      runs: 2,
      failures: 1,
      lastStartedAt: at(5),
      lastSucceededAt: T0,
      lastFailedAt: at(5),
      lastError: "could not reach [email]",
    });
    expect(rows.outbox).toMatchObject({ runs: 1, failures: 1, lastSucceededAt: null });
  });
});

describe("operational signals", () => {
  it("reports a healthy database and no job signals when the scheduler is off", async () => {
    const signals = byKey(await collectSignals(db, { now: T0, jobsScheduled: false }));
    expect(signals.schema?.status).toBe("ok");
    expect(signals.notifications).toMatchObject({ status: "ok", detail: "nothing waiting" });
    expect(signals["notification-failures"]?.status).toBe("ok");
    expect(Object.keys(signals).filter((k) => k.startsWith("job:"))).toEqual([]);
  });

  it("flags jobs that never ran, ran too long ago, or failed last time", async () => {
    let signals = byKey(await collectSignals(db, { now: T0, jobsScheduled: true }));
    expect(signals["job:outbox"]?.status).toBe("warn");
    expect(signals["job:outbox"]?.detail).toContain("never run");

    await withJobRun(db, "outbox", () => Promise.resolve({}), { now: () => T0 });
    await withJobRun(db, "payments", () => Promise.resolve({}), { now: () => T0 });
    await withJobRun(db, "retention", () => Promise.resolve({}), { now: () => T0 });
    signals = byKey(await collectSignals(db, { now: at(5), jobsScheduled: true }));
    expect(signals["job:outbox"]?.status).toBe("ok");
    expect(signals["job:payments"]?.status).toBe("ok");

    // The outbox is expected every minute: 20 minutes is late, two hours is broken.
    signals = byKey(await collectSignals(db, { now: at(20), jobsScheduled: true }));
    expect(signals["job:outbox"]).toMatchObject({ status: "warn", detail: "last ran 20 min ago" });
    expect(signals["job:retention"]?.status).toBe("ok");
    signals = byKey(await collectSignals(db, { now: at(120), jobsScheduled: true }));
    expect(signals["job:outbox"]?.status).toBe("fail");

    await withJobRun(db, "payments", () => Promise.resolve(null), {
      isFailure: () => true,
      now: () => at(121),
    });
    signals = byKey(await collectSignals(db, { now: at(122), jobsScheduled: true }));
    expect(signals["job:payments"]?.status).toBe("fail");
    expect(signals["job:payments"]?.detail).toContain("last run failed");
  });

  it("warns when notifications wait, fails when they're stuck, and counts the ones that gave up", async () => {
    const message = (n: number, status: string, nextAttemptAt: Date) => ({
      channel: "email",
      template: "order_ready",
      recipient: `customer${n}@example.test`,
      locale: "fr",
      dedupeKey: `test-${n}`,
      status,
      nextAttemptAt,
      updatedAt: T0,
    });
    await db.insert(outboxMessages).values(message(1, "pending", at(-15)));
    let signals = byKey(await collectSignals(db, { now: T0, jobsScheduled: false }));
    expect(signals.notifications).toMatchObject({
      status: "warn",
      detail: "1 waiting, oldest 15 min",
    });

    await db
      .insert(outboxMessages)
      .values([message(2, "pending", at(-45)), message(3, "failed", at(-60))]);
    signals = byKey(await collectSignals(db, { now: T0, jobsScheduled: false }));
    expect(signals.notifications).toMatchObject({
      status: "fail",
      detail: "2 waiting, oldest 45 min",
    });
    expect(signals["notification-failures"]?.status).toBe("warn");
    // Nothing personal in what an alert would carry.
    expect(JSON.stringify(signals)).not.toContain("@example.test");
  });
});

describe("the monitor alerts on changes only", () => {
  const signal = (status: Signal["status"]): Signal => ({
    signal: "schema",
    status,
    detail: `is ${status}`,
  });

  it("stays quiet while healthy, alerts when it breaks, once, and when it recovers", async () => {
    const alert = vi.fn<(a: Alert) => Promise<boolean>>().mockResolvedValue(true);
    const run = (status: Signal["status"], minutes: number) =>
      runMonitor(db, [signal(status)], { now: at(minutes), alert });

    expect(await run("ok", 0)).toMatchObject({ status: "ok", alerted: 0 });
    expect(await run("ok", 5)).toMatchObject({ changed: [] });
    expect(await run("fail", 10)).toMatchObject({
      status: "fail",
      changed: ["schema"],
      alerted: 1,
    });
    expect(await run("fail", 15)).toMatchObject({ changed: [], alerted: 0 });
    expect(await run("warn", 20)).toMatchObject({ alerted: 1 });
    expect(await run("ok", 25)).toMatchObject({ status: "ok", alerted: 1 });

    expect(alert.mock.calls.map(([a]) => [a.level, a.title])).toEqual([
      ["fail", "Problem: schema"],
      ["warn", "Warning: schema"],
      ["ok", "Recovered: schema"],
    ]);
  });

  it("alerts at once for a signal first seen broken, and retries if the webhook was down", async () => {
    const alert = vi.fn<(a: Alert) => Promise<boolean>>().mockResolvedValue(false);
    expect(await runMonitor(db, [signal("fail")], { now: T0, alert })).toMatchObject({
      changed: ["schema"],
      alerted: 0,
    });
    // The webhook is back: the same problem is announced now, still dated from when it began.
    alert.mockResolvedValue(true);
    expect(await runMonitor(db, [signal("fail")], { now: at(5), alert })).toMatchObject({
      changed: [],
      alerted: 1,
    });
    expect(await runMonitor(db, [signal("fail")], { now: at(10), alert })).toMatchObject({
      alerted: 0,
    });
    expect(alert).toHaveBeenCalledTimes(2);
    const [row] = await db.execute<{ since: Date; notified_at: Date | null }>(
      sql`select since, notified_at from monitor_signals where signal = 'schema'`,
    );
    expect(new Date(row!.since)).toEqual(T0);
    expect(new Date(row!.notified_at!)).toEqual(at(5));
  });
});
