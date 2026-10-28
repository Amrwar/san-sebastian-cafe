import "server-only";
import { eq, jobRuns, sql, type Database } from "@ssc/db";
import { scrub } from "./alerts";

export type JobName = "outbox" | "payments" | "retention" | "monitor";

/**
 * How often each job is expected to run, and when a missing run becomes worrying. Generous on
 * purpose: external schedulers drift, and Hobby plans may run some jobs less often.
 */
export const JOB_SCHEDULE: Record<JobName, { warnAfterMin: number; failAfterMin: number }> = {
  outbox: { warnAfterMin: 15, failAfterMin: 60 },
  payments: { warnAfterMin: 30, failAfterMin: 120 },
  retention: { warnAfterMin: 26 * 60, failAfterMin: 50 * 60 },
  monitor: { warnAfterMin: 30, failAfterMin: 120 },
};

/**
 * Runs a scheduled job and records the run: started, then succeeded or failed (with a short,
 * scrubbed error). For a job that reports failure in its result instead of throwing (the
 * outbox returns null), `isFailure` tells the two apart.
 */
export async function withJobRun<T>(
  db: Database,
  job: JobName,
  run: () => Promise<T>,
  {
    isFailure = () => false,
    now = () => new Date(),
  }: { isFailure?: (result: T) => boolean; now?: () => Date } = {},
): Promise<T> {
  await db
    .insert(jobRuns)
    .values({ job, lastStartedAt: now(), runs: 1 })
    .onConflictDoUpdate({
      target: jobRuns.job,
      set: { lastStartedAt: now(), runs: sql`${jobRuns.runs} + 1` },
    });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await recordFailure(db, job, error instanceof Error ? error.message : String(error), now());
    throw error;
  }
  if (isFailure(result)) await recordFailure(db, job, "the run reported a failure", now());
  else await db.update(jobRuns).set({ lastSucceededAt: now() }).where(eq(jobRuns.job, job));
  return result;
}

async function recordFailure(db: Database, job: JobName, message: string, at: Date) {
  await db
    .update(jobRuns)
    .set({
      lastFailedAt: at,
      lastError: scrub(message, 200),
      failures: sql`${jobRuns.failures} + 1`,
    })
    .where(eq(jobRuns.job, job));
}

export interface JobRunView {
  job: JobName;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
  runs: number;
  failures: number;
}

export async function listJobRuns(db: Database): Promise<JobRunView[]> {
  const rows = await db.select().from(jobRuns);
  return rows.map((r) => ({ ...r, job: r.job as JobName }));
}
