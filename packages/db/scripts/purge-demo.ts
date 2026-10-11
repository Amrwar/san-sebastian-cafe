import { purgeDemoData } from "../src/maintenance";
import { run } from "./_run";

// Allowed in any environment: it only removes rows flagged is_demo.
await run("purge-demo", async (db) => {
  await purgeDemoData(db);
  return "all is_demo records removed";
});
