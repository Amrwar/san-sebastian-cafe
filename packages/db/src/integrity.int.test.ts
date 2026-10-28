import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database, DbHandle } from "./index";
import { checkIntegrity } from "./integrity";
import { seedDemoData } from "./seed";
import { giftCards, giftCardTransactions, loyaltyAccounts, orders, payments } from "./schema/index";
import { createTestDatabase } from "./testing";

/*
 * The integrity checks the restore drill relies on: a consistent database passes, and each kind
 * of damage a bad restore (or a bug) could cause is caught and pointed at.
 */

let handle: DbHandle;
let db: Database;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table users, categories, modifier_groups, promotions, delivery_zones, orders,
      payment_events, audit_events, gift_cards restart identity cascade
  `);
  await seedDemoData(db, new Date("2026-10-12T14:00:00Z"));
});

async function failing(): Promise<Record<string, string[]>> {
  const report = await checkIntegrity(db);
  return Object.fromEntries(report.checks.filter((c) => !c.ok).map((c) => [c.name, c.sample]));
}

describe("integrity checks", () => {
  it("a consistent database passes every check and reports its row counts", async () => {
    const report = await checkIntegrity(db);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rowCounts.orders).toBeGreaterThan(0);
    expect(report.rowCounts.loyalty_transactions).toBeGreaterThan(0);
  });

  it("a loyalty balance that no longer matches its ledger is caught", async () => {
    const [account] = await db.select().from(loyaltyAccounts).limit(1);
    await db
      .update(loyaltyAccounts)
      .set({ stampBalance: account!.stampBalance + 1 })
      .where(eq(loyaltyAccounts.id, account!.id));
    expect(await failing()).toEqual({
      "loyalty: balance and debt match the ledger": [account!.id],
    });
  });

  it("a gift card balance that no longer matches its ledger is caught", async () => {
    const [card] = await db
      .insert(giftCards)
      .values({
        codeHash: "h".repeat(64),
        codeLast4: "ABCD",
        initialCents: 2500,
        balanceCents: 2500,
      })
      .returning();
    await db.insert(giftCardTransactions).values({
      giftCardId: card!.id,
      kind: "issue",
      deltaCents: 2500,
      balanceAfterCents: 2500,
    });
    expect(await failing()).toEqual({});
    await db.update(giftCards).set({ balanceCents: 2000 }).where(eq(giftCards.id, card!.id));
    expect(await failing()).toEqual({ "gift cards: balance matches the ledger": [card!.id] });
  });

  it("refunds missing from a payment, or a paid order without its money, are caught", async () => {
    const [payment] = await db.select().from(payments).limit(1);
    await db.update(payments).set({ refundedCents: 50 }).where(eq(payments.id, payment!.id));
    expect(Object.keys(await failing())).toEqual([
      "payments: refunded amount matches the settled refunds",
    ]);
    await db.update(payments).set({ refundedCents: 0 }).where(eq(payments.id, payment!.id));

    // The payment row lost (e.g. a table left out of a restore): the order is paid, no money.
    await db.delete(payments).where(eq(payments.id, payment!.id));
    expect(await failing()).toEqual({
      "orders: every paid order was paid in full": [payment!.orderId],
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, payment!.orderId));
    expect(order!.paidAt).not.toBeNull();
  });
});
