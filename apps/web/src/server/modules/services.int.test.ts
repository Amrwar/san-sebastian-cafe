import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  categories,
  eq,
  loyaltyAccounts,
  products,
  productVariants,
  sql,
  users,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { createTestDatabase } from "@ssc/db/testing";
import { ROLES, type Role } from "@ssc/domain";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { getCatalogOverview, listRecentAuditEvents } from "./admin/overview";
import { getPublishedMenu } from "./catalog/menu";
import { getAccountSettings, updateAccountSettings } from "./identity/account-settings";
import { provisionAccount } from "./identity/provisioning";
import { countOrdersByStatus } from "./ordering/order-summary";

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
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, audit_events restart identity cascade`,
  );
});

async function createActor(role: Role): Promise<Actor> {
  const userId = randomUUID();
  await db
    .insert(users)
    .values({ id: userId, name: "Test", email: `${userId}@example.test`, role });
  await provisionAccount(db, userId);
  return { userId, role };
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

const validSettings = {
  name: "Marie",
  preferredLocale: "fr-CA",
  orderUpdatesEmail: true,
  marketingEmail: false,
};

describe("authorization matrix", () => {
  // Expected minimum role for each protected service call.
  const cases: Array<{
    name: string;
    minRole: Role;
    call: (actor: Actor | null) => Promise<unknown>;
  }> = [
    { name: "getAccountSettings", minRole: "customer", call: (a) => getAccountSettings(db, a) },
    {
      name: "updateAccountSettings",
      minRole: "customer",
      call: (a) => updateAccountSettings(db, a, validSettings),
    },
    { name: "countOrdersByStatus", minRole: "staff", call: (a) => countOrdersByStatus(db, a) },
    { name: "getCatalogOverview", minRole: "manager", call: (a) => getCatalogOverview(db, a) },
    {
      name: "listRecentAuditEvents",
      minRole: "manager",
      call: (a) => listRecentAuditEvents(db, a),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: anonymous → unauthenticated`, async () => {
      expect(await errorCode(c.call(null))).toBe("unauthenticated");
    });

    for (const role of ROLES) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(c.minRole);
      it(`${c.name}: ${role} → ${allowed ? "allowed" : "forbidden"}`, async () => {
        const actor = await createActor(role);
        expect(await errorCode(c.call(actor))).toBe(allowed ? null : "forbidden");
      });
    }
  }
});

describe("account provisioning", () => {
  it("is idempotent and privacy-protective by default", async () => {
    const actor = await createActor("customer");
    await provisionAccount(db, actor.userId);
    const settings = await getAccountSettings(db, actor);
    expect(settings).toMatchObject({
      preferredLocale: "fr-CA",
      orderUpdatesEmail: true,
      marketingEmail: false,
    });
    const accountsForUser = await db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.userId, actor.userId));
    expect(accountsForUser).toHaveLength(1);
  });
});

describe("account settings", () => {
  it("rejects invalid input with field paths", async () => {
    const actor = await createActor("customer");
    try {
      await updateAccountSettings(db, actor, {
        ...validSettings,
        name: "  ",
        preferredLocale: "de-DE",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).fieldIssues.map((i) => i.path).sort()).toEqual([
        "name",
        "preferredLocale",
      ]);
    }
  });

  it("updates only the actor's own record, ignoring any role in the payload", async () => {
    const actor = await createActor("customer");
    const other = await createActor("customer");
    await updateAccountSettings(db, actor, {
      ...validSettings,
      name: "Marie Tremblay",
      role: "owner",
      userId: other.userId,
    });
    const [me] = await db.select().from(users).where(eq(users.id, actor.userId));
    const [them] = await db.select().from(users).where(eq(users.id, other.userId));
    expect(me).toMatchObject({ name: "Marie Tremblay", role: "customer" });
    expect(them?.name).toBe("Test");
  });

  it("timestamps marketing consent and audits grant and withdrawal exactly once", async () => {
    const actor = await createActor("customer");
    const granted = await updateAccountSettings(db, actor, {
      ...validSettings,
      marketingEmail: true,
    });
    expect(granted.marketingEmail).toBe(true);
    expect(granted.marketingConsentedAt).toBeInstanceOf(Date);

    // Saving again without a change records nothing new.
    await updateAccountSettings(db, actor, {
      ...validSettings,
      marketingEmail: true,
      name: "Renamed",
    });
    const withdrawn = await updateAccountSettings(db, actor, {
      ...validSettings,
      marketingEmail: false,
    });
    expect(withdrawn.marketingConsentedAt).toBeNull();

    const events = await db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => e.action)).toEqual([
      "consent.marketing_email.granted",
      "consent.marketing_email.withdrawn",
    ]);
    expect(events.every((e) => e.actorUserId === actor.userId)).toBe(true);
  });
});

describe("published menu", () => {
  it("shows visible products with their lowest available price and hides hidden or archived items", async () => {
    const [category] = await db
      .insert(categories)
      .values({ slug: "drinks", nameFr: "Boissons", nameEn: "Drinks" })
      .returning();
    const insertProduct = async (
      slug: string,
      extra: Partial<typeof products.$inferInsert> = {},
    ) => {
      const [p] = await db
        .insert(products)
        .values({ categoryId: category!.id, slug, nameFr: slug, nameEn: slug, ...extra })
        .returning();
      return p!;
    };
    const visible = await insertProduct("latte");
    await insertProduct("secret", { availability: "hidden" });
    await insertProduct("old", { archivedAt: new Date() });
    const noPrice = await insertProduct("no-variant");
    await db.insert(productVariants).values([
      { productId: visible.id, nameFr: "P", nameEn: "S", priceCents: 450, isDefault: true },
      {
        productId: visible.id,
        nameFr: "G",
        nameEn: "L",
        priceCents: 300,
        availability: "sold_out",
      },
      { productId: visible.id, nameFr: "M", nameEn: "M", priceCents: 500 },
    ]);
    await db
      .insert(categories)
      .values({ slug: "hidden-cat", nameFr: "X", nameEn: "X", isVisible: false });

    const menu = await getPublishedMenu(db);
    expect(menu.map((c) => c.slug)).toEqual(["drinks"]);
    const slugs = menu[0]!.products.map((p) => p.slug);
    expect(slugs).toEqual(["latte", "no-variant"]);
    expect(menu[0]!.products[0]).toMatchObject({ fromPriceCents: 450, availability: "available" });
    // A product with no purchasable variant cannot be ordered.
    expect(menu[0]!.products.find((p) => p.id === noPrice.id)).toMatchObject({
      fromPriceCents: null,
      availability: "sold_out",
    });
  });
});
