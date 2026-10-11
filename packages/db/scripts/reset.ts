import { sql } from "drizzle-orm";
import { assertNonProductionDatabase, runMigrations } from "../src/maintenance";
import { seedDemoData } from "../src/seed";
import { run } from "./_run";

await run("reset", async (db, appEnv) => {
  assertNonProductionDatabase(appEnv);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  await seedDemoData(db);
  return "database dropped, migrated and re-seeded with demo data";
});
