import { loadRootEnv } from "@ssc/env";
import { fromCommandLine, restoreBackup } from "./_backup";
import { redact } from "./_pg";
import { printRestore } from "./_report";

/*
 * npm run db:restore -- <file.dump> --target <empty database url>
 * Restores a dump into an EMPTY database (a new local database or a new Neon branch), then checks
 * the copy. It never restores over the database the app is using.
 */
loadRootEnv();
const file = process.argv[2];
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex > 0 ? process.argv[targetIndex + 1] : undefined;

try {
  if (!file || file.startsWith("--") || !target)
    throw new Error("Usage: npm run db:restore -- <file.dump> --target <empty database url>");
  if (
    process.env.DATABASE_URL &&
    new URL(target).toString() === new URL(process.env.DATABASE_URL).toString()
  )
    throw new Error("The target is DATABASE_URL, the database in use: restore into a new one");
  const result = await restoreBackup(fromCommandLine(file), target);
  printRestore("db:restore", result);
  if (!result.ok) throw new Error("the restored copy failed its checks");
  console.log(`[db:restore] ${redact(target)} restored and checked.`);
} catch (error) {
  console.error("[db:restore] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
