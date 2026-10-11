import "server-only";
import { createDb, type Database, type DbHandle } from "@ssc/db";
import { env } from "./env";

// Reuse one pool across hot reloads in development and across requests in a server instance.
const globalForDb = globalThis as unknown as { __sscDb?: DbHandle };

export function db(): Database {
  globalForDb.__sscDb ??= createDb(env().DATABASE_URL);
  return globalForDb.__sscDb.db;
}
