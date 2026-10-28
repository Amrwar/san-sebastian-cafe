import { loadRootEnv } from "@ssc/env";
import { createBackup, DEFAULT_BACKUP_DIR, fromCommandLine } from "./_backup";
import { redact } from "./_pg";

/*
 * npm run db:backup [-- --out <dir>]
 * Dumps BACKUP_DATABASE_URL (or DATABASE_URL) with a manifest. On Neon, use the direct
 * (unpooled) connection string: pg_dump can't run through the pooler.
 */
loadRootEnv();
const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const dir = out ? fromCommandLine(out) : DEFAULT_BACKUP_DIR;

try {
  if (!url) throw new Error("Set DATABASE_URL (or BACKUP_DATABASE_URL)");
  const started = Date.now();
  const { file, manifest } = await createBackup(url, dir);
  const rows = Object.values(manifest.rowCounts).reduce((a, b) => a + b, 0);
  console.log(
    `[db:backup] ${redact(url)} → ${file} (${(manifest.sizeBytes / 1024).toFixed(0)} KB, ${rows} rows, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  console.log("[db:backup] Personal information inside: keep it encrypted and in Canada.");
} catch (error) {
  console.error("[db:backup] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
