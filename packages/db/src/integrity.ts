import { sql } from "drizzle-orm";
import type { Database, Tx } from "./index";
import { appliedMigrations, EXPECTED_MIGRATIONS } from "./schema-version";

/*
 * Integrity checks for a live database or a restored copy. The CHECK constraints already guard
 * each row (an order's total adds up, no balance below zero); these checks cover what spans rows:
 * cached balances against their ledgers, refunds against payments, paid orders against the money
 * received. Read-only. Used by `npm run db:verify` and the restore drill.
 */

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  /** How many rows break the rule (0 when ok). */
  failures: number;
  /** A few ids of rows that break it, to investigate (never personal data). */
  sample: string[];
}

export interface IntegrityReport {
  ok: boolean;
  checks: IntegrityCheck[];
  /** Rows per table in the public schema, for comparing a copy with its source. */
  rowCounts: Record<string, number>;
}

const SAMPLE = 5;

async function rule(db: Database, name: string, query: ReturnType<typeof sql>) {
  const rows = await db.execute<{ id: string }>(query);
  return {
    name,
    ok: rows.length === 0,
    failures: rows.length,
    sample: rows.slice(0, SAMPLE).map((r) => r.id),
  };
}

export async function tableRowCounts(db: Database | Tx): Promise<Record<string, number>> {
  const tables = await db.execute<{ name: string }>(
    sql`select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(name)}`,
    );
    counts[name] = row?.n ?? 0;
  }
  return counts;
}

export async function checkIntegrity(db: Database): Promise<IntegrityReport> {
  const applied = await appliedMigrations(db);
  const checks: IntegrityCheck[] = [
    {
      name: "migrations: all applied",
      ok: applied === EXPECTED_MIGRATIONS,
      failures: applied === EXPECTED_MIGRATIONS ? 0 : Math.abs(EXPECTED_MIGRATIONS - applied),
      sample: applied === EXPECTED_MIGRATIONS ? [] : [`${applied}/${EXPECTED_MIGRATIONS}`],
    },
    // A restore that skipped validation would leave constraints NOT VALID.
    await rule(
      db,
      "constraints: all validated",
      sql`select conname as id from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public' and not c.convalidated`,
    ),
    await rule(
      db,
      "loyalty: balance and debt match the ledger",
      sql`select a.id from loyalty_accounts a
          left join (select account_id, sum(stamps)::int as stamps, sum(debt_delta)::int as debt
                     from loyalty_transactions group by account_id) t on t.account_id = a.id
          where a.stamp_balance <> coalesce(t.stamps, 0) or a.stamp_debt <> coalesce(t.debt, 0)`,
    ),
    await rule(
      db,
      "gift cards: balance matches the ledger",
      sql`select g.id from gift_cards g
          left join (select gift_card_id, sum(delta_cents)::int as total
                     from gift_card_transactions group by gift_card_id) t on t.gift_card_id = g.id
          where g.balance_cents <> coalesce(t.total, 0)`,
    ),
    await rule(
      db,
      "payments: refunded amount matches the settled refunds",
      sql`select p.id from payments p
          left join (select payment_id, sum(amount_cents)::int as total from refunds
                     where status = 'succeeded' and payment_id is not null group by payment_id) r
            on r.payment_id = p.id
          where p.refunded_cents <> coalesce(r.total, 0)`,
    ),
    // Card payment plus gift card equals the total (the reports' reconciliation rule).
    await rule(
      db,
      "orders: every paid order was paid in full",
      sql`select o.id from orders o
          left join payments p on p.order_id = o.id and p.reconciliation is null
            and p.status <> 'failed'
          where o.paid_at is not null
            and coalesce(p.amount_cents, 0) + o.gift_card_cents <> o.total_cents`,
    ),
    await rule(
      db,
      "stock: counted items match their last movement",
      sql`select p.id from products p
          join lateral (select quantity_after from stock_movements m where m.product_id = p.id
                        order by m.created_at desc, m.id desc limit 1) last on true
          where p.stock_quantity is distinct from last.quantity_after
          union all
          select o.id from modifier_options o
          join lateral (select quantity_after from stock_movements m where m.option_id = o.id
                        order by m.created_at desc, m.id desc limit 1) last on true
          where o.stock_quantity is distinct from last.quantity_after`,
    ),
  ];
  return { ok: checks.every((c) => c.ok), checks, rowCounts: await tableRowCounts(db) };
}
