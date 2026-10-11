import { randomUUID } from "node:crypto";
import type { Role } from "@ssc/domain";
import type { Database } from "./index";
import { purgeDemoData } from "./maintenance";
import {
  categories,
  customerProfiles,
  deliveryZones,
  loyaltyAccounts,
  loyaltyTransactions,
  modifierGroups,
  modifierOptions,
  notificationPreferences,
  productModifierGroups,
  productVariants,
  products,
  promotions,
  users,
} from "./schema/index";

/*
 * DEVELOPMENT SEED DATA — NOT the café's real menu, prices or staff.
 * Every row is flagged is_demo = true, every name carries a "[DÉMO]"/"[DEMO]" prefix, slugs start
 * with "demo-", and emails use the reserved ".invalid" TLD so nothing can be delivered.
 * The real menu must come from the owner (docs/07-open-decisions.md, section C).
 */

export const DEMO_EMAIL_DOMAIN = "demo.san-sebastian.invalid";
const fr = (s: string) => `[DÉMO] ${s}`;
const en = (s: string) => `[DEMO] ${s}`;

export const DEMO_USERS: ReadonlyArray<{ role: Role; name: string; email: string }> = [
  { role: "owner", name: "Demo Owner", email: `owner@${DEMO_EMAIL_DOMAIN}` },
  { role: "manager", name: "Demo Manager", email: `manager@${DEMO_EMAIL_DOMAIN}` },
  { role: "shift_lead", name: "Demo Shift Lead", email: `lead@${DEMO_EMAIL_DOMAIN}` },
  { role: "staff", name: "Demo Barista", email: `staff@${DEMO_EMAIL_DOMAIN}` },
  { role: "customer", name: "Demo Customer", email: `customer@${DEMO_EMAIL_DOMAIN}` },
];

export interface SeedSummary {
  users: number;
  categories: number;
  products: number;
}

/** Replaces all demo data with a fresh copy. Real (is_demo = false) data is never touched. */
export async function seedDemoData(db: Database): Promise<SeedSummary> {
  await purgeDemoData(db);

  return db.transaction(async (tx) => {
    // --- Users, profiles, preferences, loyalty ------------------------------------------------
    for (const u of DEMO_USERS) {
      const id = randomUUID();
      await tx.insert(users).values({
        id,
        name: u.name,
        email: u.email,
        emailVerified: true,
        role: u.role,
        isDemo: true,
      });
      await tx.insert(customerProfiles).values({ userId: id, preferredLocale: "fr-CA" });
      await tx.insert(notificationPreferences).values([
        { userId: id, channel: "email", topic: "order_updates", enabled: true },
        { userId: id, channel: "email", topic: "marketing", enabled: false },
      ]);
      if (u.role === "customer") {
        const [account] = await tx
          .insert(loyaltyAccounts)
          .values({ userId: id, stampBalance: 3, lifetimeStamps: 3, isDemo: true })
          .returning({ id: loyaltyAccounts.id });
        await tx.insert(loyaltyTransactions).values({
          accountId: account!.id,
          kind: "adjust",
          stamps: 3,
          reason: "Development seed balance",
        });
      }
    }

    // --- Catalog -------------------------------------------------------------------------------
    const [drinks, bakery] = await tx
      .insert(categories)
      .values([
        {
          slug: "demo-espresso-bar",
          nameFr: fr("Bar espresso"),
          nameEn: en("Espresso bar"),
          sortOrder: 1,
          isDemo: true,
        },
        {
          slug: "demo-bakery",
          nameFr: fr("Viennoiseries"),
          nameEn: en("Bakery"),
          sortOrder: 2,
          isDemo: true,
        },
      ])
      .returning({ id: categories.id });

    const [temperature, milk, syrups, shots] = await tx
      .insert(modifierGroups)
      .values([
        {
          nameFr: fr("Température"),
          nameEn: en("Temperature"),
          selection: "single",
          minSelected: 1,
          maxSelected: 1,
          isDemo: true,
        },
        {
          nameFr: fr("Lait"),
          nameEn: en("Milk"),
          selection: "single",
          minSelected: 1,
          maxSelected: 1,
          isDemo: true,
        },
        {
          nameFr: fr("Sirops"),
          nameEn: en("Syrups"),
          selection: "multiple",
          minSelected: 0,
          maxSelected: 3,
          isDemo: true,
        },
        {
          nameFr: fr("Espresso supplémentaire"),
          nameEn: en("Extra espresso"),
          selection: "multiple",
          minSelected: 0,
          maxSelected: 2,
          isDemo: true,
        },
      ])
      .returning({ id: modifierGroups.id });

    await tx.insert(modifierOptions).values([
      { groupId: temperature!.id, nameFr: "Chaud", nameEn: "Hot", isDefault: true, sortOrder: 1 },
      { groupId: temperature!.id, nameFr: "Glacé", nameEn: "Iced", sortOrder: 2 },
      {
        groupId: milk!.id,
        nameFr: "Lait entier",
        nameEn: "Whole milk",
        isDefault: true,
        sortOrder: 1,
      },
      {
        groupId: milk!.id,
        nameFr: "Boisson d’avoine",
        nameEn: "Oat beverage",
        priceDeltaCents: 75,
        sortOrder: 2,
      },
      {
        groupId: syrups!.id,
        nameFr: "Vanille",
        nameEn: "Vanilla",
        priceDeltaCents: 60,
        sortOrder: 1,
      },
      {
        groupId: syrups!.id,
        nameFr: "Caramel",
        nameEn: "Caramel",
        priceDeltaCents: 60,
        sortOrder: 2,
      },
      {
        groupId: shots!.id,
        nameFr: "Espresso",
        nameEn: "Espresso shot",
        priceDeltaCents: 100,
        sortOrder: 1,
      },
    ]);

    const [latte, americano, croissant] = await tx
      .insert(products)
      .values([
        {
          categoryId: drinks!.id,
          slug: "demo-latte",
          nameFr: fr("Latte"),
          nameEn: en("Latte"),
          descriptionFr: "Produit de démonstration. Prix et description fictifs.",
          descriptionEn: "Demonstration product. Placeholder price and description.",
          isDrink: true,
          loyaltyQualifying: true,
          rewardEligible: true,
          sortOrder: 1,
          isDemo: true,
        },
        {
          categoryId: drinks!.id,
          slug: "demo-americano",
          nameFr: fr("Americano"),
          nameEn: en("Americano"),
          descriptionFr: "Produit de démonstration. Prix et description fictifs.",
          descriptionEn: "Demonstration product. Placeholder price and description.",
          isDrink: true,
          loyaltyQualifying: true,
          rewardEligible: true,
          sortOrder: 2,
          isDemo: true,
        },
        {
          categoryId: bakery!.id,
          slug: "demo-croissant",
          nameFr: fr("Croissant"),
          nameEn: en("Croissant"),
          descriptionFr: "Produit de démonstration. Prix et description fictifs.",
          descriptionEn: "Demonstration product. Placeholder price and description.",
          sortOrder: 1,
          availability: "sold_out",
          isDemo: true,
        },
      ])
      .returning({ id: products.id });

    await tx.insert(productVariants).values([
      {
        productId: latte!.id,
        nameFr: "Petit",
        nameEn: "Small",
        priceCents: 100,
        isDefault: true,
        sortOrder: 1,
      },
      { productId: latte!.id, nameFr: "Grand", nameEn: "Large", priceCents: 200, sortOrder: 2 },
      {
        productId: americano!.id,
        nameFr: "Régulier",
        nameEn: "Regular",
        priceCents: 100,
        isDefault: true,
        sortOrder: 1,
      },
      {
        productId: croissant!.id,
        nameFr: "Unité",
        nameEn: "Each",
        priceCents: 100,
        isDefault: true,
        sortOrder: 1,
      },
    ]);

    await tx.insert(productModifierGroups).values([
      { productId: latte!.id, groupId: temperature!.id, sortOrder: 1 },
      { productId: latte!.id, groupId: milk!.id, sortOrder: 2 },
      { productId: latte!.id, groupId: syrups!.id, sortOrder: 3 },
      { productId: latte!.id, groupId: shots!.id, sortOrder: 4 },
      { productId: americano!.id, groupId: temperature!.id, sortOrder: 1 },
      { productId: americano!.id, groupId: shots!.id, sortOrder: 2 },
    ]);

    // --- Growth config (inactive placeholders) ---------------------------------------------------
    await tx.insert(promotions).values({
      code: "DEMO10",
      nameFr: fr("Promotion inactive"),
      nameEn: en("Inactive promotion"),
      kind: "percent_off",
      value: 1000,
      startsAt: new Date("2026-01-01T00:00:00Z"),
      isActive: false,
      isDemo: true,
    });
    await tx.insert(deliveryZones).values({
      nameFr: fr("Zone fictive"),
      nameEn: en("Placeholder zone"),
      postalPrefixes: ["H0H"],
      feeCents: 100,
      estimatedMinutes: 30,
      isActive: false,
      isDemo: true,
    });

    return { users: DEMO_USERS.length, categories: 2, products: 3 };
  });
}
