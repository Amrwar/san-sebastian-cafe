import { assertNonProductionDatabase } from "../src/maintenance";
import { seedDemoData } from "../src/seed";
import { run } from "./_run";

await run("seed", async (db, appEnv) => {
  assertNonProductionDatabase(appEnv);
  const s = await seedDemoData(db);
  return `demo data loaded (${s.users} users, ${s.categories} categories, ${s.products} products, ${s.orders} orders) — all flagged is_demo`;
});
