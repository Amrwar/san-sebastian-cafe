import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as tables from "./schema/index";
import * as relations from "./schema/relations";

export const schema = { ...tables, ...relations };
export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
/** A transaction handle has the same query API as the database. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    // PgBouncer-style poolers (e.g. Neon "-pooler" hosts) in transaction mode cannot keep
    // prepared statements across transactions.
    prepare: !new URL(url).hostname.includes("-pooler"),
    // Keep Postgres notices (e.g. "relation already exists, skipping") out of app logs.
    onnotice: () => undefined,
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export * from "./schema/index";
export { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
