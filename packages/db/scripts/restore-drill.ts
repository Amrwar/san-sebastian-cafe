import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRootEnv } from "@ssc/env";
import postgres from "postgres";
import { createBackup, DEFAULT_BACKUP_DIR, restoreBackup } from "./_backup";
import { redact } from "./_pg";
import { printRestore } from "./_report";

/*
 * npm run db:restore-drill [-- --target <empty database url>] [--keep]
 *
 * The backup drill, start to finish: dumps DATABASE_URL (BACKUP_DATABASE_URL if set), restores it
 * into a scratch database, checks the copy (integrity rules, row counts against the dump), times
 * each step, then drops the scratch database. The source is only read. Without --target, the
 * scratch database is created on the same server (`<name>_restore_drill`); on Neon, pass a new
 * branch's connection string instead. The dump goes to a temporary folder and is deleted; the
 * drill's report (no personal data) is written to backups/.
 */
loadRootEnv();
const source = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
const targetIndex = process.argv.indexOf("--target");
const givenTarget = targetIndex > 0 ? process.argv[targetIndex + 1] : undefined;
const keep = process.argv.includes("--keep");

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/** Creates (or recreates) the scratch database next to the source; returns its URL. */
async function scratchDatabase(
  sourceUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new URL(sourceUrl);
  const name = `${admin.pathname.slice(1)}_restore_drill`.replace(/[^a-z0-9_]/gi, "_");
  admin.pathname = "/postgres";
  const client = postgres(admin.toString(), { max: 1, onnotice: () => undefined });
  const ident = `"${name}"`;
  try {
    await client.unsafe(`drop database if exists ${ident} with (force)`);
    await client.unsafe(`create database ${ident}`);
  } finally {
    await client.end({ timeout: 5 });
  }
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = postgres(admin.toString(), { max: 1, onnotice: () => undefined });
      try {
        await c.unsafe(`drop database if exists ${ident} with (force)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    },
  };
}

let workDir: string | null = null;
let cleanup: (() => Promise<void>) | null = null;
try {
  if (!source) throw new Error("Set DATABASE_URL (or BACKUP_DATABASE_URL)");
  const startedAt = new Date();
  workDir = await mkdtemp(join(tmpdir(), "ssc-drill-"));

  let t = Date.now();
  const { file, manifest } = await createBackup(source, workDir);
  const backupSeconds = seconds(Date.now() - t);
  console.log(
    `[db:restore-drill] 1. backup of ${redact(source)}: ${(manifest.sizeBytes / 1024).toFixed(0)} KB in ${backupSeconds} s`,
  );

  let target = givenTarget;
  if (!target) {
    const scratch = await scratchDatabase(source);
    target = scratch.url;
    if (!keep) cleanup = scratch.drop;
  }
  t = Date.now();
  const result = await restoreBackup(file, target);
  const restoreSeconds = seconds(Date.now() - t);
  console.log(
    `[db:restore-drill] 2. restored into ${redact(target)} and checked in ${restoreSeconds} s`,
  );
  printRestore("db:restore-drill", result);

  const report = {
    drill: "backup → restore → verify",
    startedAt: startedAt.toISOString(),
    source: manifest.source,
    target: { host: new URL(target).hostname, database: new URL(target).pathname.slice(1) },
    serverVersion: manifest.serverVersion,
    migrations: manifest.migrations,
    dumpBytes: manifest.sizeBytes,
    rows: Object.values(manifest.rowCounts).reduce((a, b) => a + b, 0),
    tables: Object.keys(manifest.rowCounts).length,
    backupSeconds,
    restoreSeconds,
    totalSeconds: seconds(Date.now() - startedAt.getTime()),
    checks: result.integrity.checks.map((c) => ({ name: c.name, ok: c.ok, failures: c.failures })),
    countMismatches: result.countMismatches,
    ok: result.ok,
  };
  const reportFile = join(
    DEFAULT_BACKUP_DIR,
    `drill_${startedAt.toISOString().replace(/[:.]/g, "-").replace("Z", "")}.json`,
  );
  await mkdir(DEFAULT_BACKUP_DIR, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[db:restore-drill] ${result.ok ? "PASSED" : "FAILED"} in ${report.totalSeconds} s — report: ${reportFile}`,
  );
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error("[db:restore-drill] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (cleanup) await cleanup();
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
