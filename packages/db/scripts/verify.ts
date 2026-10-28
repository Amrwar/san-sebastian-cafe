import { checkIntegrity } from "../src/integrity";
import { run } from "./_run";

await run("verify", async (db) => {
  const report = await checkIntegrity(db);
  for (const c of report.checks)
    console.log(
      `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` — ${c.failures} (e.g. ${c.sample.join(", ")})`}`,
    );
  const rows = Object.values(report.rowCounts).reduce((a, b) => a + b, 0);
  if (!report.ok) throw new Error("integrity checks failed");
  return `all ${report.checks.length} checks passed (${Object.keys(report.rowCounts).length} tables, ${rows} rows)`;
});
