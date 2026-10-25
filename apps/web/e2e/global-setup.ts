import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createDb, sql } from "@ssc/db";
import { runMigrations } from "@ssc/db/maintenance";
import { seedDemoData } from "@ssc/db/seed";
import { loadRootEnv } from "@ssc/env";

/** Resets the dedicated E2E database to migrations + demo seed, and clears captured dev emails. */
export default async function globalSetup(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL_E2E;
  if (!url) throw new Error("DATABASE_URL_E2E is required for end-to-end tests (see .env.example)");
  if (!new URL(url).pathname.includes("e2e"))
    throw new Error("Refusing to reset a database whose name lacks 'e2e'");

  const { db, close } = createDb(url, { max: 1 });
  try {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await runMigrations(db);
    await seedDemoData(db);
  } finally {
    await close();
  }
  await rm(join(process.cwd(), ".dev-mail"), { recursive: true, force: true });
  await rm(join(process.cwd(), ".dev-uploads"), { recursive: true, force: true });
}
