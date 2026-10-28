import type { RestoreResult } from "./_backup";

export function printRestore(tag: string, result: RestoreResult): void {
  for (const c of result.integrity.checks)
    console.log(
      `[${tag}] ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` — ${c.failures} (e.g. ${c.sample.join(", ")})`}`,
    );
  const tables = Object.keys(result.integrity.rowCounts).length;
  if (result.countMismatches.length === 0)
    console.log(`[${tag}] ok   row counts match the manifest (${tables} tables)`);
  for (const m of result.countMismatches)
    console.log(`[${tag}] FAIL ${m.table}: ${m.restored} rows, ${m.expected} in the dump`);
}
