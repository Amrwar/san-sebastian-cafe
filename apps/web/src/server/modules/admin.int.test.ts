import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  orderItems,
  productVariants,
  sql,
  users,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import {
  archiveCategory,
  archiveModifierGroup,
  archiveProduct,
  getAdminProduct,
  listAdminMenu,
  listModifierGroups,
  reorderMenu,
  saveCategory,
  saveModifierGroup,
  saveProduct,
  type AdminProduct,
} from "./admin/menu";
import { getPublishedMenu } from "./catalog/menu";
import { getProductBySlug } from "./catalog/storefront";
import { quoteCart } from "./ordering/cart-quote";
import { placeOrder } from "./ordering/place-order";
import { computeAvailability, loadStoreConfig } from "./store/pickup";
import {
  addClosure,
  getStoreAdmin,
  removeClosure,
  saveOpeningHours,
  saveStoreSettings,
} from "./admin/store";

/*
 * Menu administration: permissions, validation, audit, and the guarantee that editing the menu
 * never rewrites an order already placed.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");

let handle: DbHandle;
let db: Database;
let staff: Actor;
let lead: Actor;
let manager: Actor;
let customer: Actor;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
  customer = { userId: (await byEmail("customer")).id, role: "customer" };
});

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

/** The edit form's submission for a product as it is now. */
function asInput(p: AdminProduct) {
  return {
    categoryId: p.categoryId,
    nameFr: p.nameFr,
    nameEn: p.nameEn,
    descriptionFr: p.descriptionFr,
    descriptionEn: p.descriptionEn,
    allergenNoteFr: p.allergenNoteFr,
    allergenNoteEn: p.allergenNoteEn,
    taxCategory: p.taxCategory,
    isDrink: p.isDrink,
    isFeatured: p.isFeatured,
    loyaltyQualifying: p.loyaltyQualifying,
    rewardEligible: p.rewardEligible,
    availability: p.availability,
    variants: p.variants,
    modifierGroupIds: p.modifierGroupIds,
    windows: p.windows,
  };
}

async function drinksCategory() {
  const menu = await listAdminMenu(db, manager);
  return menu.find((c) => c.slug === "demo-espresso-bar")!;
}

async function newDrink(overrides: Record<string, unknown> = {}) {
  const [group] = await listModifierGroups(db, manager);
  return saveProduct(db, manager, {
    categoryId: (await drinksCategory()).id,
    nameFr: "Café filtre",
    nameEn: "Filter coffee",
    descriptionFr: "Torréfaction locale",
    descriptionEn: "",
    allergenNoteFr: null,
    allergenNoteEn: null,
    taxCategory: "standard",
    isDrink: true,
    isFeatured: false,
    loyaltyQualifying: true,
    rewardEligible: true,
    availability: "available",
    variants: [
      { nameFr: "Petit", nameEn: "Small", priceCents: 275, isDefault: true },
      { nameFr: "Grand", nameEn: "Large", priceCents: 325, isDefault: false },
    ],
    modifierGroupIds: [group!.id],
    windows: [],
    ...overrides,
  });
}

describe("permissions and audit", () => {
  it("only managers and above manage the menu, and every change is audited", async () => {
    for (const actor of [customer, staff, lead]) {
      expect(await failure(listAdminMenu(db, actor))).toBe("forbidden");
      expect(await failure(newDrinkAs(actor))).toBe("forbidden");
    }
    expect(await failure(listAdminMenu(db, null))).toBe("unauthenticated");
    const { id } = await newDrink();
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "catalog.product_created"));
    expect(audit).toMatchObject({
      actorUserId: manager.userId,
      entityType: "product",
      entityId: id,
    });
  });

  async function newDrinkAs(actor: Actor) {
    return saveProduct(db, actor, {});
  }
});

describe("products", () => {
  it("a new product appears on the public menu with its sizes and options", async () => {
    const { slug } = await newDrink();
    expect(slug).toBe("cafe-filtre");
    const product = await getProductBySlug(db, slug);
    expect(product).toMatchObject({ nameEn: "Filter coffee", descriptionEn: null });
    expect(product!.variants.map((v) => [v.nameEn, v.priceCents, v.isDefault])).toEqual([
      ["Small", 275, true],
      ["Large", 325, false],
    ]);
    expect(product!.groups).toHaveLength(1);
    // Same name again: a distinct address.
    expect((await newDrink()).slug).toBe("cafe-filtre-2");
  });

  it("refuses inconsistent products", async () => {
    const bad = async (overrides: Record<string, unknown>) => failure(newDrink(overrides));
    expect(await bad({ isDrink: false })).toBe("validation_failed"); // stamps are for drinks
    expect(
      await bad({
        variants: [
          { nameFr: "A", nameEn: "A", priceCents: 100, isDefault: true },
          { nameFr: "B", nameEn: "B", priceCents: 200, isDefault: true },
        ],
      }),
    ).toBe("validation_failed");
    expect(await bad({ variants: [] })).toBe("validation_failed");
    expect(await bad({ nameEn: "  " })).toBe("validation_failed");
    expect(await bad({ categoryId: randomUUID() })).toBe("validation_failed");
    expect(await bad({ modifierGroupIds: [randomUUID()] })).toBe("validation_failed");
    expect(await bad({ windows: [{ weekday: 1, startMinute: 600, endMinute: 540 }] })).toBe(
      "validation_failed",
    );
  });

  it("a price change applies to new orders only; past orders keep what was charged", async () => {
    const latte = (await getProductBySlug(db, "demo-latte"))!;
    const large = latte.variants[1]!;
    const lines = [
      {
        lineId: "l1",
        productId: latte.id,
        variantId: large.id,
        // Temperature and milk are required choices.
        optionIds: latte.groups
          .flatMap((g) => g.options)
          .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
          .map((o) => o.id),
        quantity: 1,
      },
    ];
    const quote = await quoteCart(db, null, { lines }, NOW);
    const placed = await placeOrder(
      db,
      null,
      {
        idempotencyKey: randomUUID(),
        lines,
        fulfilment: { method: "pickup", when: { kind: "asap" } },
        contact: { name: "Alex", email: "alex@example.test" },
        expectedTotalCents: quote.quote.totalCents,
        locale: "fr-CA",
      },
      { provider: "fake", now: NOW },
    );

    const edit = await getAdminProduct(db, manager, latte.id);
    await saveProduct(
      db,
      manager,
      {
        ...asInput(edit),
        variants: edit.variants.map((v) => (v.id === large.id ? { ...v, priceCents: 450 } : v)),
      },
      latte.id,
    );

    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    expect(item!.unitPriceCents).toBe(quote.quote.lines[0]!.unitPriceCents);
    const requote = await quoteCart(db, null, { lines }, NOW);
    expect(requote.quote.lines[0]!.unitPriceCents).toBeGreaterThan(item!.unitPriceCents);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "catalog.product_updated"));
    expect(audit!.metadata).toMatchObject({
      priceChanges: [{ size: large.nameFr, from: large.priceCents, to: 450 }],
    });
  });

  it("a size removed from a product is archived, not deleted", async () => {
    const { id } = await newDrink();
    const edit = await getAdminProduct(db, manager, id);
    await saveProduct(
      db,
      manager,
      { ...asInput(edit), variants: [{ ...edit.variants[0]!, isDefault: true }] },
      id,
    );
    expect((await getAdminProduct(db, manager, id)).variants.map((v) => v.nameEn)).toEqual([
      "Small",
    ]);
    const rows = await db.select().from(productVariants).where(eq(productVariants.productId, id));
    expect(rows.filter((v) => v.archivedAt !== null).map((v) => v.nameEn)).toEqual(["Large"]);
    // A size id from another product is refused.
    const other = (await getProductBySlug(db, "demo-latte"))!.variants[0]!;
    expect(
      await failure(
        saveProduct(
          db,
          manager,
          { ...asInput(edit), variants: [{ ...other, nameFr: "X", nameEn: "X", isDefault: true }] },
          id,
        ),
      ),
    ).toBe("validation_failed");
  });

  it("archiving takes a product off the menu", async () => {
    const { id, slug } = await newDrink();
    await archiveProduct(db, manager, id);
    expect(await getProductBySlug(db, slug)).toBeNull();
    expect(await failure(getAdminProduct(db, manager, id))).toBe("not_found");
    expect(await failure(archiveProduct(db, manager, id))).toBe("not_found");
  });
});

describe("categories and order", () => {
  it("creates, renames and archives categories, refusing to archive one with products", async () => {
    const { id } = await saveCategory(db, manager, {
      nameFr: "Thés",
      nameEn: "Teas",
      descriptionFr: null,
      descriptionEn: null,
      isVisible: false,
    });
    let menu = await listAdminMenu(db, manager);
    expect(menu.at(-1)).toMatchObject({ id, slug: "thes", isVisible: false, products: [] });
    // Hidden categories stay off the public menu.
    expect((await getPublishedMenu(db, NOW)).some((c) => c.id === id)).toBe(false);

    await saveCategory(
      db,
      manager,
      { nameFr: "Thés", nameEn: "Teas", descriptionFr: null, descriptionEn: null, isVisible: true },
      id,
    );
    expect((await getPublishedMenu(db, NOW)).some((c) => c.id === id)).toBe(false); // still empty
    const product = await newDrink({ categoryId: id });
    expect((await getPublishedMenu(db, NOW)).find((c) => c.id === id)?.products).toHaveLength(1);

    expect(await failure(archiveCategory(db, manager, id))).toBe("category_not_empty");
    await archiveProduct(db, manager, product.id);
    await archiveCategory(db, manager, id);
    menu = await listAdminMenu(db, manager);
    expect(menu.some((c) => c.id === id)).toBe(false);
  });

  it("reorders categories and products, refusing a stale list", async () => {
    const menu = await listAdminMenu(db, manager);
    const reversed = menu.map((c) => c.id).reverse();
    await reorderMenu(db, manager, { ids: reversed });
    expect((await listAdminMenu(db, manager)).map((c) => c.id)).toEqual(reversed);
    expect(await failure(reorderMenu(db, manager, { ids: reversed.slice(1) }))).toBe("stale_order");

    const drinks = await drinksCategory();
    const ids = drinks.products.map((p) => p.id).reverse();
    await reorderMenu(db, manager, { ids }, drinks.id);
    expect((await drinksCategory()).products.map((p) => p.id)).toEqual(ids);
    expect(await failure(reorderMenu(db, manager, { ids: [...ids, ids[0]] }, drinks.id))).toBe(
      "validation_failed",
    );
  });
});

describe("option groups", () => {
  const group = (overrides: Record<string, unknown> = {}) => ({
    nameFr: "Lait",
    nameEn: "Milk",
    selection: "single",
    minSelected: 1,
    maxSelected: 1,
    options: [
      { nameFr: "Entier", nameEn: "Whole", priceDeltaCents: 0, isDefault: true },
      { nameFr: "Avoine", nameEn: "Oat", priceDeltaCents: 60, isDefault: false },
    ],
    ...overrides,
  });

  it("validates choice rules and archives options that are removed", async () => {
    expect(await failure(saveModifierGroup(db, manager, group({ maxSelected: 2 })))).toBe(
      "validation_failed",
    );
    expect(
      await failure(
        saveModifierGroup(db, manager, group({ selection: "multiple", maxSelected: 3 })),
      ),
    ).toBe("validation_failed");
    expect(await failure(saveModifierGroup(db, staff, group()))).toBe("forbidden");

    const { id } = await saveModifierGroup(db, manager, group());
    const saved = (await listModifierGroups(db, manager)).find((g) => g.id === id)!;
    await saveModifierGroup(
      db,
      manager,
      group({ options: [{ ...saved.options[1]!, priceDeltaCents: 75, isDefault: true }] }),
      id,
    );
    const updated = (await listModifierGroups(db, manager)).find((g) => g.id === id)!;
    expect(updated.options.map((o) => [o.nameEn, o.priceDeltaCents])).toEqual([["Oat", 75]]);
  });

  it("an option group in use can't be archived", async () => {
    const { id } = await saveModifierGroup(db, manager, group());
    const product = await newDrink({ modifierGroupIds: [id] });
    expect((await listModifierGroups(db, manager)).find((g) => g.id === id)?.usedBy).toBe(1);
    expect(await failure(archiveModifierGroup(db, manager, id))).toBe("group_in_use");
    await archiveProduct(db, manager, product.id);
    await archiveModifierGroup(db, manager, id);
    expect((await listModifierGroups(db, manager)).some((g) => g.id === id)).toBe(false);
  });
});

describe("store settings", () => {
  const settings = {
    onlineOrderingEnabled: true,
    prepMinutes: 12,
    slotMinutes: 10,
    daysAhead: 7,
    orderCutoffMinutes: 15,
    minLeadMinutes: 20,
    maxOrdersPerSlot: 8,
    autoAccept: true,
    unpaidTtlMinutes: 15,
  };

  it("saves ordering settings (managers only), replacing the demo values, audited", async () => {
    expect(await failure(saveStoreSettings(db, lead, settings))).toBe("forbidden");
    expect(await failure(saveStoreSettings(db, manager, { ...settings, slotMinutes: 2 }))).toBe(
      "validation_failed",
    );
    await saveStoreSettings(db, manager, settings);
    const config = await loadStoreConfig(db);
    expect(config.settings).toMatchObject(settings);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "store.settings_changed"));
    expect(audit!.metadata).toMatchObject({ changed: { prepMinutes: { to: 12 } } });
  });

  it("replaces opening hours; a day without hours is closed", async () => {
    const overlap = {
      hours: [
        { weekday: 1, opensAtMinute: 420, closesAtMinute: 720 },
        { weekday: 1, opensAtMinute: 700, closesAtMinute: 1080 },
      ],
    };
    expect(await failure(saveOpeningHours(db, manager, overlap))).toBe("validation_failed");
    // Monday closed, Tuesday split around lunch.
    await saveOpeningHours(db, manager, {
      hours: [
        { weekday: 2, opensAtMinute: 420, closesAtMinute: 690 },
        { weekday: 2, opensAtMinute: 780, closesAtMinute: 1080 },
      ],
    });
    const admin = await getStoreAdmin(db, manager, NOW);
    expect(admin.hours).toHaveLength(2);
    expect(admin.usesDemoValues).toBe(false);
    // NOW is a Monday morning: nothing can be ordered for today.
    const availability = await computeAvailability(db, await loadStoreConfig(db), NOW);
    expect(availability.asapAvailable).toBe(false);
  });

  it("closes a date, warning about orders already booked for it", async () => {
    const latte = (await getProductBySlug(db, "demo-latte"))!;
    const lines = [
      {
        lineId: "l1",
        productId: latte.id,
        variantId: latte.variants[0]!.id,
        optionIds: latte.groups
          .flatMap((g) => g.options)
          .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
          .map((o) => o.id),
        quantity: 1,
      },
    ];
    const quote = await quoteCart(db, null, { lines }, NOW);
    await placeOrder(
      db,
      null,
      {
        idempotencyKey: randomUUID(),
        lines,
        fulfilment: { method: "pickup", when: { kind: "asap" } },
        contact: { name: "Alex", email: "alex@example.test" },
        expectedTotalCents: quote.quote.totalCents,
        locale: "fr-CA",
      },
      { provider: "fake", now: NOW },
    );

    expect(
      await failure(addClosure(db, manager, { localDate: "2026-10-11", reasonFr: null }, NOW)),
    ).toBe("validation_failed");
    expect(
      await addClosure(
        db,
        manager,
        { localDate: "2026-10-12", reasonFr: "Inventaire", reasonEn: "Stocktaking" },
        NOW,
      ),
    ).toEqual({ upcomingOrders: 1 });
    const availability = await computeAvailability(db, await loadStoreConfig(db), NOW);
    expect(availability.asapAvailable).toBe(false);
    expect((await getStoreAdmin(db, manager, NOW)).closures).toEqual([
      {
        localDate: "2026-10-12",
        reasonFr: "Inventaire",
        reasonEn: "Stocktaking",
        upcomingOrders: 1,
      },
    ]);

    await removeClosure(db, manager, "2026-10-12");
    expect(await failure(removeClosure(db, manager, "2026-10-12"))).toBe("not_found");
    expect((await computeAvailability(db, await loadStoreConfig(db), NOW)).asapAvailable).toBe(
      true,
    );
  });
});
