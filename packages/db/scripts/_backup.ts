import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "../src/index";
import { checkIntegrity, tableRowCounts, type IntegrityReport } from "../src/integrity";
import { appliedMigrations } from "../src/schema-version";
import { pgDump, pgRestore, redact } from "./_pg";

/*
 * Backup and restore with a manifest beside each dump: where it came from (no password), when,
 * the schema version, the rows per table at the moment of the dump, and the file's SHA-256. A
 * restore checks the file against its manifest, then the restored copy against the manifest and
 * the integrity rules. Dumps hold customers' personal information: keep them encrypted, in
 * Canada, and delete them on the same schedule as the database's own history.
 */

export interface BackupManifest {
  createdAt: string;
  source: { host: string; database: string };
  serverVersion: string;
  migrations: number;
  /** Rows per table in the dump (counted in the same snapshot pg_dump read). */
  rowCounts: Record<string, number>;
  file: string;
  sizeBytes: number;
  sha256: string;
}

/** backups/ at the repository root (git-ignored). */
export const DEFAULT_BACKUP_DIR = fileURLToPath(new URL("../../../backups", import.meta.url));

/** A path typed on the command line, relative to where the command was run (npm moves cwd). */
export const fromCommandLine = (path: string) =>
  resolve(process.env.INIT_CWD ?? process.cwd(), path);

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").replace("Z", "");

/** Dumps `url` into `dir`; returns the dump's path and manifest. */
export async function createBackup(
  url: string,
  dir = DEFAULT_BACKUP_DIR,
): Promise<{ file: string; manifest: BackupManifest }> {
  await mkdir(dir, { recursive: true });
  const source = new URL(url);
  const database = source.pathname.slice(1);
  const now = new Date();
  const file = join(dir, `${database}_${stamp(now)}.dump`);

  // A read-only snapshot held open while pg_dump runs: the row counts describe exactly the dump,
  // even if the café keeps taking orders meanwhile.
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  let rowCounts: Record<string, number> = {};
  let migrations = 0;
  let serverVersion = "";
  try {
    await client.begin("isolation level repeatable read read only", async (tx) => {
      const [snap] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
      const [version] = await tx<{ v: string }[]>`select current_setting('server_version') as v`;
      serverVersion = version?.v ?? "";
      const scoped = createDb(url, { max: 1 });
      try {
        // Counts read through the same snapshot as the dump.
        await scoped.db.transaction(
          async (inner) => {
            await inner.execute(sql.raw(`set transaction snapshot '${snap!.id}'`));
            rowCounts = await tableRowCounts(inner);
            const [m] = await inner.execute<{ n: number }>(
              sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
            );
            migrations = m?.n ?? 0;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } finally {
        await scoped.close();
      }
      await pgDump(url, file, snap!.id);
    });
  } finally {
    await client.end({ timeout: 5 });
  }

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    source: { host: source.hostname, database },
    serverVersion,
    migrations,
    rowCounts,
    file: file.split(/[\\/]/).pop() ?? file,
    sizeBytes: (await stat(file)).size,
    sha256: await sha256(file),
  };
  await writeFile(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { file, manifest };
}

export async function readManifest(file: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(`${file}.json`, "utf8")) as BackupManifest;
}

export interface RestoreResult {
  integrity: IntegrityReport;
  /** Tables whose row count differs from the manifest (empty when the copy is complete). */
  countMismatches: Array<{ table: string; expected: number; restored: number }>;
  ok: boolean;
}

/** Tables in the target's public schema (a restore only goes into an empty database). */
async function tableCount(url: string): Promise<number> {
  const handle = createDb(url, { max: 1 });
  try {
    const [row] = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema in ('public', 'drizzle')`,
    );
    return row?.n ?? 0;
  } finally {
    await handle.close();
  }
}

/**
 * Restores `file` into `targetUrl`, which must be an empty database (never the source: an
 * accidental restore over live data would lose everything since the dump). Then checks the copy.
 */
export async function restoreBackup(file: string, targetUrl: string): Promise<RestoreResult> {
  const manifest = await readManifest(file);
  if ((await sha256(file)) !== manifest.sha256)
    throw new Error("The dump doesn't match its manifest (damaged or edited): not restoring");
  if ((await tableCount(targetUrl)) > 0)
    throw new Error(
      `${redact(targetUrl)} is not empty: restore into a new database (or a new Neon branch)`,
    );
  await pgRestore(file, targetUrl);
  return verifyRestore(targetUrl, manifest);
}

export async function verifyRestore(
  targetUrl: string,
  manifest: BackupManifest,
): Promise<RestoreResult> {
  const handle = createDb(targetUrl, { max: 1 });
  try {
    const integrity = await checkIntegrity(handle.db);
    const tables = new Set([
      ...Object.keys(manifest.rowCounts),
      ...Object.keys(integrity.rowCounts),
    ]);
    const countMismatches = [...tables]
      .map((table) => ({
        table,
        expected: manifest.rowCounts[table] ?? 0,
        restored: integrity.rowCounts[table] ?? 0,
      }))
      .filter((m) => m.expected !== m.restored);
    const migrationsOk = (await appliedMigrations(handle.db)) === manifest.migrations;
    return {
      integrity,
      countMismatches,
      ok: integrity.ok && countMismatches.length === 0 && migrationsOk,
    };
  } finally {
    await handle.close();
  }
}
