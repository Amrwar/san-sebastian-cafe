import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database, DbHandle } from "./index";
import { purgeDemoData } from "./maintenance";
import { DEMO_USERS, seedDemoData } from "./seed";
import {
  categories,
  loyaltyAccounts,
  loyaltyTransactions,
  orderItems,
  orders,
  paymentEvents,
  productVariants,
  products,
  rewardRedemptions,
  rewards,
  users,
} from "./schema/index";
import { createTestDatabase } from "./testing";

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
      payment_events, audit_events restart identity cascade
  `);
});

/** Postgres error code of a failed promise (23505 unique, 23514 check, 23503 FK). */
async function pgErrorCode(promise: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    let current: unknown = error;
    while (current && typeof current === "object") {
      if ("code" in current && typeof current.code === "string") return current.code;
      current = "cause" in current ? current.cause : undefined;
    }
    throw error;
  }
}

async function insertUser(email = `${randomUUID()}@example.test`) {
  const id = randomUUID();
  await db.insert(users).values({ id, name: "Test", email });
  return id;
}

async function insertProduct() {
  const [category] = await db
    .insert(categories)
    .values({ slug: `c-${randomUUID()}`, nameFr: "Cat", nameEn: "Cat" })
    .returning();
  const [product] = await db
    .insert(products)
    .values({
      categoryId: category!.id,
      slug: `p-${randomUUID()}`,
      nameFr: "Prod",
      nameEn: "Prod",
      isDrink: true,
      loyaltyQualifying: true,
    })
    .returning();
  const [variant] = await db
    .insert(productVariants)
    .values({
      productId: product!.id,
      nameFr: "Petit",
      nameEn: "Small",
      priceCents: 450,
      isDefault: true,
    })
    .returning();
  return { product: product!, variant: variant! };
}

function orderValues(
  overrides: Partial<typeof orders.$inferInsert> = {},
): typeof orders.$inferInsert {
  return {
    number: `T-${randomUUID().slice(0, 8)}`,
    guestEmail: "guest@example.test",
    locale: "fr-CA",
    subtotalCents: 1000,
    gstCents: 50,
    qstCents: 100,
    totalCents: 1150,
    pricingSnapshot: {},
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

describe("migrations", () => {
  it("create every core table", async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "users",
      "customer_profiles",
      "notification_preferences",
      "categories",
      "products",
      "product_variants",
      "modifier_groups",
      "modifier_options",
      "orders",
      "order_items",
      "payments",
      "payment_events",
      "loyalty_accounts",
      "loyalty_transactions",
      "rewards",
      "reward_redemptions",
      "promotions",
      "delivery_zones",
      "audit_events",
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe("demo data", () => {
  it("seeds idempotently and purges without touching real records", async () => {
    const realUserId = await insertUser("real.customer@example.test");
    await seedDemoData(db);
    await seedDemoData(db);

    const demoUsers = await db.select().from(users).where(eq(users.isDemo, true));
    expect(demoUsers).toHaveLength(DEMO_USERS.length);
    expect(demoUsers.every((u) => u.email.endsWith(".invalid"))).toBe(true);

    const demoProducts = await db.select().from(products);
    expect(demoProducts.length).toBeGreaterThan(0);
    expect(
      demoProducts.every(
        (p) => p.isDemo && p.slug.startsWith("demo-") && p.nameEn.startsWith("[DEMO]"),
      ),
    ).toBe(true);

    await purgeDemoData(db);
    expect(await db.select().from(products)).toHaveLength(0);
    const remaining = await db.select().from(users);
    expect(remaining.map((u) => u.id)).toEqual([realUserId]);
  });
});

describe("integrity constraints", () => {
  it("treats emails case-insensitively", async () => {
    await insertUser("Same@Example.test");
    expect(await pgErrorCode(insertUser("same@example.test"))).toBe("23505");
  });

  it("allows only one default variant per product", async () => {
    const { product } = await insertProduct();
    const extraDefault = db.insert(productVariants).values({
      productId: product.id,
      nameFr: "Grand",
      nameEn: "Large",
      priceCents: 500,
      isDefault: true,
    });
    expect(await pgErrorCode(extraDefault)).toBe("23505");
  });

  it("rejects an order whose total does not add up", async () => {
    expect(await pgErrorCode(db.insert(orders).values(orderValues({ totalCents: 999 })))).toBe(
      "23514",
    );
    await db.insert(orders).values(orderValues());
  });

  it("requires an order to identify a customer or guest", async () => {
    expect(await pgErrorCode(db.insert(orders).values(orderValues({ guestEmail: null })))).toBe(
      "23514",
    );
  });

  it("rejects a duplicate order idempotency key", async () => {
    const key = randomUUID();
    await db.insert(orders).values(orderValues({ idempotencyKey: key }));
    expect(await pgErrorCode(db.insert(orders).values(orderValues({ idempotencyKey: key })))).toBe(
      "23505",
    );
  });

  it("stores each payment webhook event once", async () => {
    const event = {
      provider: "fake" as const,
      eventId: "evt_1",
      type: "payment.succeeded",
      payload: {},
    };
    await db.insert(paymentEvents).values(event);
    expect(await pgErrorCode(db.insert(paymentEvents).values(event))).toBe("23505");
    // The idempotent path used by webhook handlers:
    const inserted = await db.insert(paymentEvents).values(event).onConflictDoNothing().returning();
    expect(inserted).toHaveLength(0);
  });

  describe("loyalty ledger", () => {
    async function setup() {
      const userId = await insertUser();
      const [account] = await db.insert(loyaltyAccounts).values({ userId }).returning();
      const { product, variant } = await insertProduct();
      const [order] = await db
        .insert(orders)
        .values(orderValues({ userId, guestEmail: null }))
        .returning();
      const [item] = await db
        .insert(orderItems)
        .values({
          orderId: order!.id,
          productId: product.id,
          variantId: variant.id,
          productNameFr: "Prod",
          productNameEn: "Prod",
          variantNameFr: "Petit",
          variantNameEn: "Small",
          quantity: 2,
          unitPriceCents: 500,
          lineTotalCents: 1000,
          taxCategory: "standard",
          isDrink: true,
          loyaltyQualifying: true,
        })
        .returning();
      return { account: account!, order: order!, item: item! };
    }

    it("never lets the cached balance go negative", async () => {
      const { account } = await setup();
      const update = db
        .update(loyaltyAccounts)
        .set({ stampBalance: -1 })
        .where(eq(loyaltyAccounts.id, account.id));
      expect(await pgErrorCode(update)).toBe("23514");
    });

    it("records each ledger operation at most once (idempotency key)", async () => {
      const { account, order } = await setup();
      const earn = {
        accountId: account.id,
        kind: "earn" as const,
        stamps: 2,
        balanceAfter: 2,
        orderId: order.id,
        idempotencyKey: `earn:${order.id}`,
      };
      await db.insert(loyaltyTransactions).values(earn);
      expect(await pgErrorCode(db.insert(loyaltyTransactions).values(earn))).toBe("23505");
    });

    it("enforces the sign of each entry kind and a reason for adjustments", async () => {
      const { account } = await setup();
      const negativeEarn = db.insert(loyaltyTransactions).values({
        accountId: account.id,
        kind: "earn",
        stamps: -1,
        balanceAfter: 0,
        idempotencyKey: "neg",
      });
      expect(await pgErrorCode(negativeEarn)).toBe("23514");
      const silentAdjust = db.insert(loyaltyTransactions).values({
        accountId: account.id,
        kind: "adjust",
        stamps: 1,
        balanceAfter: 1,
        idempotencyKey: "silent",
      });
      expect(await pgErrorCode(silentAdjust)).toBe("23514");
    });

    it("allows only one active redemption per reward", async () => {
      const { account, order } = await setup();
      const [convert] = await db
        .insert(loyaltyTransactions)
        .values({
          accountId: account.id,
          kind: "adjust",
          stamps: 5,
          balanceAfter: 5,
          reason: "test",
          idempotencyKey: "seed-adjust",
        })
        .returning();
      const [reward] = await db
        .insert(rewards)
        .values({ accountId: account.id, sourceTransactionId: convert!.id })
        .returning();
      const redemption = { rewardId: reward!.id, orderId: order.id, discountCents: 450 };
      await db.insert(rewardRedemptions).values(redemption);
      expect(await pgErrorCode(db.insert(rewardRedemptions).values(redemption))).toBe("23505");

      // A released redemption frees the reward for another attempt.
      await db
        .update(rewardRedemptions)
        .set({ status: "released" })
        .where(eq(rewardRedemptions.rewardId, reward!.id));
      await db.insert(rewardRedemptions).values(redemption);
    });
  });
});
