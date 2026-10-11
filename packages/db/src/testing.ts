import { sql } from "drizzle-orm";
import { loadRootEnv } from "@ssc/env";
import { createDb, type DbHandle } from "./index";
import { runMigrations } from "./maintenance";

/**
 * Integration-test helper. Connects to DATABASE_URL_TEST, wipes it, and applies all migrations.
 * Guards against ever running against the development or a non-test database.
 */
export async function createTestDatabase(): Promise<DbHandle> {
  loadRootEnv();
  const url = process.env.DATABASE_URL_TEST;
  if (!url)
    throw new Error("DATABASE_URL_TEST is required for integration tests (see .env.example)");
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.includes("test")) {
    throw new Error(`Refusing to reset "${dbName}": the test database name must contain "test"`);
  }
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL_TEST must differ from DATABASE_URL");
  }

  const handle = createDb(url, { max: 5 });
  await handle.db.execute(sql`drop schema if exists public cascade`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`create schema public`);
  await runMigrations(handle.db);
  return handle;
}
