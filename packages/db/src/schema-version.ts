import { sql } from "drizzle-orm";
import journal from "../migrations/meta/_journal.json";
import type { Database } from "./index";

/* Not re-exported from the package index: Node scripts (seed, E2E setup) load the index natively. */

/** How many migrations this code expects the database to have. */
export const EXPECTED_MIGRATIONS = journal.entries.length;

/**
 * Migrations applied to the database (Drizzle's own table). Fewer than expected means the code was
 * deployed before `npm run db:migrate` ran against this database.
 */
export async function appliedMigrations(db: Database): Promise<number> {
  try {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
