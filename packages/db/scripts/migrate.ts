import { runMigrations } from "../src/maintenance";
import { run } from "./_run";

await run("migrate", async (db) => {
  await runMigrations(db);
  return "migrations applied";
});
