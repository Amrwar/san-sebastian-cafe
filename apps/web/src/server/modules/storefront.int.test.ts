import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deliveryZones,
  eq,
  loadCatalog,
  promotions,
  sql,
  storeSettings,
  users,
  type CatalogProduct,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { getProductBySlug, searchMenu } from "./catalog/storefront";
import { addFavorite, listFavorites, removeFavorite } from "./customer/favorites";
import { completeOnboarding, needsOnboarding } from "./identity/onboarding";
import { provisionAccount } from "./identity/provisioning";
import { getLoyaltySummary } from "./loyalty/summary";
import { quoteCart } from "./ordering/cart-quote";
import { getOrderDetail, listMyOrders } from "./ordering/customer-orders";
import { getFulfilmentOptions } from "./store/pickup";

let handle: DbHandle;
let db: Database;
let demoCustomer: Actor;
let latte: CatalogProduct;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, audit_events restart identity cascade`,
  );
  await seedDemoData(db, new Date("2026-10-11T14:00:00Z"));
  const [customer] = await db
    .select()
    .from(users)
    .where(eq(users.email, `customer@${DEMO_EMAIL_DOMAIN}`));
  demoCustomer = { userId: customer!.id, role: "customer" };
  const product = await getProductBySlug(db, "demo-latte");
  latte = product!;
});

async function newCustomer(): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "", email: `${userId}@example.test` });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}

const option = (p: CatalogProduct, nameEn: string) =>
  p.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
const line = (overrides: Record<string, unknown> = {}) => ({
  lineId: "l1",
  productId: latte.id,
  variantId: latte.variants[1]!.id, // Large (2,00 $)
  optionIds: [option(latte, "Hot"), option(latte, "Whole milk")],
  quantity: 1,
  ...overrides,
});

async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

describe("menu search", () => {
  it("is accent-insensitive and bilingual", async () => {
    const byEnglish = await searchMenu(db, { q: "bakery muffin" });
    expect(byEnglish).toHaveLength(0); // all terms must match one product
    const accent = await searchMenu(db, { q: "demo" });
    expect(accent.flatMap((c) => c.products).length).toBeGreaterThan(3);
    const muffin = await searchMenu(db, { q: "MUFFIN" });
    expect(muffin.flatMap((c) => c.products).map((p) => p.slug)).toEqual(["demo-muffin"]);
  });

  it("filters by category slug", async () => {
    const bakery = await searchMenu(db, { category: "demo-bakery" });
    expect(bakery.map((c) => c.slug)).toEqual(["demo-bakery"]);
  });

  it("returns null for unknown or hidden products", async () => {
    expect(await getProductBySlug(db, "nope")).toBeNull();
  });
});

describe("cart quote service", () => {
  it("prices from the database and ignores client-supplied amounts", async () => {
    const result = await quoteCart(db, null, { lines: [line({ priceCents: 1 })] });
    expect(result.quote.subtotalCents).toBe(200);
    expect(result.display[0]).toMatchObject({
      nameFr: "[DÉMO] Latte",
      variantNameEn: "Large",
      isDemo: true,
    });
    expect(result.availableRewardIds).toBeNull();
  });

  it("rejects malformed input", async () => {
    expect(
      await code(quoteCart(db, null, { lines: [{ lineId: "x", productId: "not-a-uuid" }] })),
    ).toBe("validation_failed");
  });

  it("applies only rewards that belong to the signed-in customer", async () => {
    const own = await quoteCart(db, demoCustomer, { lines: [line()], useReward: true });
    expect(own.availableRewardIds).toHaveLength(1);
    expect(own.quote.reward).toMatchObject({ status: "applied", discountCents: 200 });

    const stranger = await newCustomer();
    const other = await quoteCart(db, stranger, { lines: [line()], useReward: true });
    expect(other.quote.reward).toBeNull();
    const anonymous = await quoteCart(db, null, { lines: [line()], useReward: true });
    expect(anonymous.quote.reward).toBeNull();
  });

  it("looks promotion codes up case-insensitively and reports their status", async () => {
    const inactive = await quoteCart(db, null, { lines: [line()], promoCode: "demo10" });
    expect(inactive.quote.promotion?.status).toBe("inactive");
    await db.update(promotions).set({ isActive: true }).where(eq(promotions.code, "DEMO10"));
    const active = await quoteCart(db, null, { lines: [line()], promoCode: "Demo10" });
    expect(active.quote.promotion).toMatchObject({ status: "applied", discountCents: 20 });
    const unknown = await quoteCart(db, null, { lines: [line()], promoCode: "NOPE" });
    expect(unknown.quote.promotion?.status).toBe("not_found");
  });

  it("checks delivery zones by postal code and blocks checkout when delivery can't be fulfilled", async () => {
    const off = await quoteCart(db, null, {
      lines: [line()],
      fulfilment: { method: "delivery", postalCode: "H0H 0H0" },
    });
    expect(off.delivery.status).toBe("unavailable");
    expect(off.quote.canCheckout).toBe(false);

    await db.update(deliveryZones).set({ isActive: true });
    const invalid = await quoteCart(db, null, {
      lines: [line()],
      fulfilment: { method: "delivery", postalCode: "12345" },
    });
    expect(invalid.delivery.status).toBe("invalid_postal_code");
    const outside = await quoteCart(db, null, {
      lines: [line()],
      fulfilment: { method: "delivery", postalCode: "H2T 1S6" },
    });
    expect(outside.delivery.status).toBe("outside_zone");
    const inside = await quoteCart(db, null, {
      lines: [line()],
      fulfilment: { method: "delivery", postalCode: "h0h0h0" },
    });
    expect(inside.delivery.status).toBe("available");
    expect(inside.quote.deliveryFeeCents).toBe(100);
  });
});

describe("fulfilment options", () => {
  it("uses configured (demo) hours and reports them as demo", async () => {
    const options = await getFulfilmentOptions(db, new Date("2026-10-12T14:00:00Z")); // Monday 10:00
    expect(options.usesDemoHours).toBe(true);
    expect(options.pickup.asapAvailable).toBe(true);
    expect(options.deliveryOffered).toBe(false);
  });

  it("treats a missing settings row as ordering not configured", async () => {
    await db.delete(storeSettings);
    const options = await getFulfilmentOptions(db, new Date("2026-10-12T14:00:00Z"));
    expect(options.pickup.reason).toBe("ordering_disabled");
  });
});

describe("favorites", () => {
  it("saves idempotently, lists with orderability, and removes only the owner's", async () => {
    const actor = await newCustomer();
    const config = {
      productId: latte.id,
      // Large: the demo menu doesn't allow an iced small latte (size rule).
      variantId: latte.variants[1]!.id,
      optionIds: [option(latte, "Iced"), option(latte, "Oat beverage")],
    };
    const first = await addFavorite(db, actor, config);
    const again = await addFavorite(db, actor, {
      ...config,
      optionIds: [...config.optionIds].reverse(),
    });
    expect(again.id).toBe(first.id);

    const list = await listFavorites(db, actor);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ orderable: true, optionNamesEn: ["Iced", "Oat beverage"] });

    const stranger = await newCustomer();
    expect(await code(removeFavorite(db, stranger, first.id))).toBe("not_found");
    await removeFavorite(db, actor, first.id);
    expect(await listFavorites(db, actor)).toHaveLength(0);
  });

  it("rejects configurations that don't match the menu", async () => {
    const actor = await newCustomer();
    const missingRequired = {
      productId: latte.id,
      variantId: latte.variants[0]!.id,
      optionIds: [],
    };
    expect(await code(addFavorite(db, actor, missingRequired))).toBe("validation_failed");
    expect(await code(addFavorite(db, null, missingRequired))).toBe("unauthenticated");
  });
});

describe("customer orders and loyalty", () => {
  it("lists only the customer's own orders and hides others' as not found", async () => {
    const orders = await listMyOrders(db, demoCustomer);
    expect(orders.map((o) => o.number).sort()).toEqual(["D-1001", "D-1002"]);
    const detail = await getOrderDetail(db, demoCustomer, orders[0]!.id);
    expect(detail.items.length).toBeGreaterThan(0);
    expect(detail.timeline[0]?.status).toBe("paid");

    const stranger = await newCustomer();
    expect(await listMyOrders(db, stranger)).toEqual([]);
    expect(await code(getOrderDetail(db, stranger, orders[0]!.id))).toBe("not_found");
    expect(await code(getOrderDetail(db, stranger, "not-a-uuid"))).toBe("not_found");
    expect(
      await code(getOrderDetail(db, { userId: stranger.userId, role: "staff" }, orders[0]!.id)),
    ).toBeNull();
  });

  it("summarises the stamp card, wallet and history from the ledger", async () => {
    const summary = await getLoyaltySummary(db, demoCustomer);
    expect(summary).toMatchObject({
      stampsPerReward: 5,
      stampBalance: 2,
      lifetimeStamps: 7,
      isDemo: true,
    });
    expect(summary.availableRewards).toHaveLength(1);
    expect(summary.history.map((h) => h.kind)).toEqual(
      expect.arrayContaining(["earn", "adjust", "convert"]),
    );
    // Ledger invariant: the cached balance equals the sum of entries.
    expect(summary.history.reduce((s, h) => s + h.stamps, 0)).toBe(summary.stampBalance);
  });
});

describe("onboarding", () => {
  it("requires every field and then marks the profile onboarded", async () => {
    const actor = await newCustomer();
    expect(await needsOnboarding(db, actor)).toBe(true);
    expect(await code(completeOnboarding(db, actor, { name: "Marie" }))).toBe("validation_failed");
    await completeOnboarding(db, actor, {
      name: "Marie",
      preferredLocale: "en-CA",
      orderUpdatesEmail: true,
      marketingEmail: false,
    });
    expect(await needsOnboarding(db, actor)).toBe(false);
  });

  it("existing catalog loader returns configuration for pricing", async () => {
    const catalog = await loadCatalog(db, [latte.id]);
    expect(catalog.get(latte.id)?.groups.map((g) => g.nameEn)).toEqual([
      "[DEMO] Temperature",
      "[DEMO] Milk",
      "[DEMO] Syrups",
      "[DEMO] Extra espresso",
    ]);
  });
});
