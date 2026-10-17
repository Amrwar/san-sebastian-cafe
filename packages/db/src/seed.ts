import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { computeQuote, type Role } from "@ssc/domain";
import type { Database, Tx } from "./index";
import { purgeDemoData } from "./maintenance";
import { loadCatalog } from "./queries/catalog";
import {
  categories,
  customerProfiles,
  deliveryZones,
  favorites,
  loyaltyAccounts,
  loyaltyPrograms,
  loyaltyTransactions,
  modifierGroups,
  modifierOptions,
  notificationPreferences,
  openingHours,
  orderItems,
  orderStatusEvents,
  orders,
  payments,
  productAvailabilityWindows,
  productModifierGroups,
  productVariants,
  products,
  promotions,
  rewards,
  storeSettings,
  users,
  variantOptionRules,
} from "./schema/index";

/*
 * DEVELOPMENT SEED DATA — NOT the café's real menu, prices, hours or staff.
 * Every root row is flagged is_demo = true, names carry a "[DÉMO]"/"[DEMO]" prefix, slugs start
 * with "demo-", emails use the reserved ".invalid" TLD, and prices are obviously placeholder
 * whole-dollar amounts. Real data must come from the owner (docs/07-open-decisions.md, §C).
 */

export const DEMO_EMAIL_DOMAIN = "demo.san-sebastian.invalid";
const fr = (s: string) => `[DÉMO] ${s}`;
const en = (s: string) => `[DEMO] ${s}`;
const DEMO_DESCRIPTION = {
  descriptionFr: "Produit de démonstration. Prix et description fictifs.",
  descriptionEn: "Demonstration product. Placeholder price and description.",
};

export const DEMO_USERS: ReadonlyArray<{ role: Role; name: string; email: string }> = [
  { role: "owner", name: "Demo Owner", email: `owner@${DEMO_EMAIL_DOMAIN}` },
  { role: "manager", name: "Demo Manager", email: `manager@${DEMO_EMAIL_DOMAIN}` },
  { role: "shift_lead", name: "Demo Shift Lead", email: `lead@${DEMO_EMAIL_DOMAIN}` },
  { role: "staff", name: "Demo Barista", email: `staff@${DEMO_EMAIL_DOMAIN}` },
  { role: "customer", name: "Demo Customer", email: `customer@${DEMO_EMAIL_DOMAIN}` },
];

type GroupKey = "temperature" | "milk" | "syrups" | "shots";

const GROUPS: Record<
  GroupKey,
  {
    nameFr: string;
    nameEn: string;
    selection: "single" | "multiple";
    min: number;
    max: number;
    options: Array<{ fr: string; en: string; delta?: number; isDefault?: boolean }>;
  }
> = {
  temperature: {
    nameFr: "Température",
    nameEn: "Temperature",
    selection: "single",
    min: 1,
    max: 1,
    options: [
      { fr: "Chaud", en: "Hot", isDefault: true },
      { fr: "Glacé", en: "Iced" },
    ],
  },
  milk: {
    nameFr: "Lait",
    nameEn: "Milk",
    selection: "single",
    min: 1,
    max: 1,
    options: [
      { fr: "Lait entier", en: "Whole milk", isDefault: true },
      { fr: "Lait écrémé", en: "Skim milk" },
      { fr: "Boisson d’avoine", en: "Oat beverage", delta: 100 },
      { fr: "Boisson d’amande", en: "Almond beverage", delta: 100 },
    ],
  },
  syrups: {
    nameFr: "Sirops",
    nameEn: "Syrups",
    selection: "multiple",
    min: 0,
    max: 3,
    options: [
      { fr: "Vanille", en: "Vanilla", delta: 100 },
      { fr: "Caramel", en: "Caramel", delta: 100 },
      { fr: "Noisette", en: "Hazelnut", delta: 100 },
    ],
  },
  shots: {
    nameFr: "Espresso supplémentaire",
    nameEn: "Extra espresso",
    selection: "multiple",
    min: 0,
    max: 1,
    options: [{ fr: "Un espresso de plus", en: "One extra shot", delta: 100 }],
  },
};

const PRODUCTS: Array<{
  slug: string;
  category: "drinks" | "bakery";
  fr: string;
  en: string;
  drink: boolean;
  featured?: boolean;
  soldOut?: boolean;
  /** Weekday windows (local), e.g. breakfast-only items. */
  windows?: Array<{ weekday: number; start: number; end: number }>;
  variants: Array<{ fr: string; en: string; price: number }>;
  groups: GroupKey[];
}> = [
  {
    slug: "demo-latte",
    category: "drinks",
    fr: "Latte",
    en: "Latte",
    drink: true,
    featured: true,
    variants: [
      { fr: "Petit", en: "Small", price: 100 },
      { fr: "Grand", en: "Large", price: 200 },
    ],
    groups: ["temperature", "milk", "syrups", "shots"],
  },
  {
    slug: "demo-cappuccino",
    category: "drinks",
    fr: "Cappuccino",
    en: "Cappuccino",
    drink: true,
    featured: true,
    variants: [
      { fr: "Petit", en: "Small", price: 100 },
      { fr: "Grand", en: "Large", price: 200 },
    ],
    groups: ["milk", "syrups", "shots"],
  },
  {
    slug: "demo-americano",
    category: "drinks",
    fr: "Americano",
    en: "Americano",
    drink: true,
    variants: [{ fr: "Régulier", en: "Regular", price: 100 }],
    groups: ["temperature", "shots"],
  },
  {
    slug: "demo-espresso",
    category: "drinks",
    fr: "Espresso",
    en: "Espresso",
    drink: true,
    featured: true,
    variants: [
      { fr: "Simple", en: "Single", price: 100 },
      { fr: "Double", en: "Double", price: 200 },
    ],
    groups: [],
  },
  {
    slug: "demo-croissant",
    category: "bakery",
    fr: "Croissant",
    en: "Croissant",
    drink: false,
    soldOut: true,
    variants: [{ fr: "Unité", en: "Each", price: 100 }],
    groups: [],
  },
  {
    slug: "demo-breakfast-bowl",
    category: "bakery",
    fr: "Bol déjeuner (matin seulement)",
    en: "Breakfast bowl (mornings only)",
    drink: false,
    // Weekdays 07:00–11:00 local: exercises availability schedules.
    windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 7 * 60, end: 11 * 60 })),
    variants: [{ fr: "Unité", en: "Each", price: 100 }],
    groups: [],
  },
  {
    slug: "demo-muffin",
    category: "bakery",
    fr: "Muffin",
    en: "Muffin",
    drink: false,
    variants: [{ fr: "Unité", en: "Each", price: 100 }],
    groups: [],
  },
];

export interface SeedSummary {
  users: number;
  categories: number;
  products: number;
  orders: number;
}

/** Replaces all demo data with a fresh copy. Real (is_demo = false) data is never touched. */
export async function seedDemoData(db: Database, now = new Date()): Promise<SeedSummary> {
  await purgeDemoData(db);

  return db.transaction(async (tx) => {
    // --- Users, profiles, preferences ----------------------------------------------------------
    const userIds = new Map<Role, string>();
    for (const u of DEMO_USERS) {
      const id = randomUUID();
      userIds.set(u.role, id);
      await tx.insert(users).values({
        id,
        name: u.name,
        email: u.email,
        emailVerified: true,
        role: u.role,
        isDemo: true,
      });
      await tx
        .insert(customerProfiles)
        .values({ userId: id, preferredLocale: "fr-CA", onboardedAt: now });
      await tx.insert(notificationPreferences).values([
        { userId: id, channel: "email", topic: "order_updates", enabled: true },
        { userId: id, channel: "email", topic: "marketing", enabled: false },
      ]);
    }

    // --- Store: demo hours (Mon–Fri 07:00–18:00, Sat–Sun 08:00–17:00) ---------------------------
    await tx.insert(storeSettings).values({
      id: 1,
      onlineOrderingEnabled: true,
      prepMinutes: 10,
      slotMinutes: 15,
      daysAhead: 2,
      orderCutoffMinutes: 15,
      maxOrdersPerSlot: 6,
      autoAccept: false,
      unpaidTtlMinutes: 15,
      isDemo: true,
    });
    await tx.insert(openingHours).values(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
        const weekend = weekday === 0 || weekday === 6;
        return {
          weekday,
          opensAtMinute: (weekend ? 8 : 7) * 60,
          closesAtMinute: (weekend ? 17 : 18) * 60,
          isDemo: true,
        };
      }),
    );

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
    const categoryIds = { drinks: drinks!.id, bakery: bakery!.id };

    const groupIds = new Map<GroupKey, string>();
    for (const [key, g] of Object.entries(GROUPS) as Array<[GroupKey, (typeof GROUPS)[GroupKey]]>) {
      const [group] = await tx
        .insert(modifierGroups)
        .values({
          nameFr: fr(g.nameFr),
          nameEn: en(g.nameEn),
          selection: g.selection,
          minSelected: g.min,
          maxSelected: g.max,
          isDemo: true,
        })
        .returning({ id: modifierGroups.id });
      groupIds.set(key, group!.id);
      await tx.insert(modifierOptions).values(
        g.options.map((o, i) => ({
          groupId: group!.id,
          nameFr: o.fr,
          nameEn: o.en,
          priceDeltaCents: o.delta ?? 0,
          isDefault: o.isDefault ?? false,
          sortOrder: i + 1,
        })),
      );
    }

    const productIds = new Map<string, string>();
    for (const [index, p] of PRODUCTS.entries()) {
      const [product] = await tx
        .insert(products)
        .values({
          categoryId: categoryIds[p.category],
          slug: p.slug,
          nameFr: fr(p.fr),
          nameEn: en(p.en),
          ...DEMO_DESCRIPTION,
          isDrink: p.drink,
          loyaltyQualifying: p.drink,
          rewardEligible: p.drink,
          isFeatured: p.featured ?? false,
          availability: p.soldOut ? "sold_out" : "available",
          sortOrder: index + 1,
          isDemo: true,
        })
        .returning({ id: products.id });
      productIds.set(p.slug, product!.id);
      if (p.windows) {
        await tx.insert(productAvailabilityWindows).values(
          p.windows.map((w) => ({
            productId: product!.id,
            weekday: w.weekday,
            startMinute: w.start,
            endMinute: w.end,
          })),
        );
      }
      await tx.insert(productVariants).values(
        p.variants.map((v, i) => ({
          productId: product!.id,
          nameFr: v.fr,
          nameEn: v.en,
          priceCents: v.price,
          isDefault: i === 0,
          sortOrder: i + 1,
        })),
      );
      if (p.groups.length > 0) {
        await tx.insert(productModifierGroups).values(
          p.groups.map((key, i) => ({
            productId: product!.id,
            groupId: groupIds.get(key)!,
            sortOrder: i + 1,
          })),
        );
      }
    }

    // --- Size-specific rules: small latte → extra shot 0,50 $, and no iced small latte ----------
    const [latteSmall] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, productIds.get("demo-latte")!),
          eq(productVariants.nameEn, "Small"),
        ),
      );
    const groupOptions = (key: GroupKey) =>
      tx
        .select({ id: modifierOptions.id, nameEn: modifierOptions.nameEn })
        .from(modifierOptions)
        .where(eq(modifierOptions.groupId, groupIds.get(key)!));
    const [shot] = await groupOptions("shots");
    const iced = (await groupOptions("temperature")).find((o) => o.nameEn === "Iced");
    await tx.insert(variantOptionRules).values([
      { variantId: latteSmall!.id, optionId: shot!.id, priceDeltaCents: 50 },
      { variantId: latteSmall!.id, optionId: iced!.id, excluded: true },
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

    // --- Demo customer: orders, loyalty, favorite ------------------------------------------------
    const customerId = userIds.get("customer")!;
    const catalog = await loadCatalog(tx, [...productIds.values()]);
    const pick = (slug: string, variantIndex: number, optionNames: string[] = []) => {
      const product = catalog.get(productIds.get(slug)!)!;
      const options = product.groups.flatMap((g) => g.options);
      const chosen = optionNames.map((name) => options.find((o) => o.nameEn === name)!.id);
      // Fill required single-choice groups with their defaults.
      for (const g of product.groups) {
        if (g.minSelected > 0 && !g.options.some((o) => chosen.includes(o.id))) {
          chosen.push((g.options.find((o) => o.isDefault) ?? g.options[0])!.id);
        }
      }
      return {
        productId: product.id,
        variantId: product.variants[variantIndex]!.id,
        optionIds: chosen,
      };
    };

    // The program's first version (also created by migration 0004; tests truncate it away).
    await tx
      .insert(loyaltyPrograms)
      .values({
        version: 1,
        stampsPerReward: 5,
        note: "Initial rule: 5 qualifying paid drinks = 1 free eligible drink",
      })
      .onConflictDoNothing();

    const [account] = await tx
      .insert(loyaltyAccounts)
      .values({ userId: customerId, stampBalance: 0, lifetimeStamps: 0, isDemo: true })
      .returning({ id: loyaltyAccounts.id });
    let earned = 0;
    let balance = 0;

    const demoOrders = [
      {
        number: "D-1001",
        placedAt: new Date(now.getTime() - 26 * 3600_000),
        status: "completed" as const,
        trail: ["paid", "accepted", "in_preparation", "ready", "completed"] as const,
        lines: [
          { ...pick("demo-latte", 1, ["Oat beverage", "Vanilla"]), quantity: 1 },
          { ...pick("demo-muffin", 0), quantity: 1 },
        ],
        tip: { kind: "percent" as const, basisPoints: 1500 },
      },
      {
        number: "D-1002",
        placedAt: new Date(now.getTime() - 6 * 60_000),
        status: "in_preparation" as const,
        trail: ["paid", "accepted", "in_preparation"] as const,
        lines: [
          { ...pick("demo-americano", 0, ["Iced"]), quantity: 2 },
          { ...pick("demo-espresso", 1), quantity: 1 },
        ],
        tip: { kind: "none" as const },
      },
    ];

    for (const o of demoOrders) {
      const quote = computeQuote({
        lines: o.lines.map((l, i) => ({ lineId: String(i), ...l })),
        catalog,
        fulfilment: { method: "pickup" },
        tip: o.tip,
        now: o.placedAt,
      });
      const [order] = await tx
        .insert(orders)
        .values({
          number: o.number,
          userId: customerId,
          status: o.status,
          locale: "fr-CA",
          subtotalCents: quote.subtotalCents,
          discountCents: quote.discountCents,
          rewardDiscountCents: quote.rewardDiscountCents,
          deliveryFeeCents: quote.deliveryFeeCents,
          gstCents: quote.gstCents,
          qstCents: quote.qstCents,
          tipCents: quote.tipCents,
          totalCents: quote.totalCents,
          pricingSnapshot: quote,
          idempotencyKey: `demo-${o.number}`,
          placedAt: o.placedAt,
          paidAt: o.placedAt,
          completedAt:
            o.status === "completed" ? new Date(o.placedAt.getTime() + 15 * 60_000) : null,
          isDemo: true,
        })
        .returning({ id: orders.id });

      const counted: Array<Record<string, unknown>> = [];
      for (const line of quote.lines) {
        const product = catalog.get(line.productId)!;
        const variant = product.variants.find((v) => v.id === line.variantId)!;
        const [item] = await tx
          .insert(orderItems)
          .values({
            orderId: order!.id,
            productId: product.id,
            variantId: variant.id,
            productNameFr: product.nameFr,
            productNameEn: product.nameEn,
            variantNameFr: variant.nameFr,
            variantNameEn: variant.nameEn,
            modifiers: product.groups.flatMap((g) =>
              g.options
                .filter((opt) => line.optionIds.includes(opt.id))
                .map((opt) => ({
                  optionId: opt.id,
                  groupNameFr: g.nameFr,
                  groupNameEn: g.nameEn,
                  nameFr: opt.nameFr,
                  nameEn: opt.nameEn,
                  priceDeltaCents: opt.priceDeltaCents,
                })),
            ),
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            taxCategory: product.taxCategory,
            isDrink: product.isDrink,
            loyaltyQualifying: product.loyaltyQualifying,
          })
          .returning({ id: orderItems.id });
        if (product.loyaltyQualifying) {
          counted.push({
            orderItemId: item!.id,
            name: { fr: product.nameFr, en: product.nameEn },
            size: { fr: variant.nameFr, en: variant.nameEn },
            quantity: line.quantity,
            stamps: line.quantity,
          });
        }
      }
      const stamps = counted.reduce((n, l) => n + (l.stamps as number), 0);
      if (stamps > 0) {
        earned += stamps;
        balance += stamps;
        await tx.insert(loyaltyTransactions).values({
          accountId: account!.id,
          kind: "earn",
          source: "online_order",
          stamps,
          balanceAfter: balance,
          idempotencyKey: `earn:order:${order!.id}`,
          orderId: order!.id,
          programVersion: 1,
          details: { orderNumber: o.number, lines: counted, notCounted: [] },
          createdAt: o.placedAt,
        });
      }

      let from: (typeof o.trail)[number] | "awaiting_payment" = "awaiting_payment";
      for (const [step, to] of o.trail.entries()) {
        await tx.insert(orderStatusEvents).values({
          orderId: order!.id,
          fromStatus: from,
          toStatus: to,
          actorKind: to === "paid" ? "webhook" : "staff",
          createdAt: new Date(o.placedAt.getTime() + step * 3 * 60_000),
        });
        from = to;
      }
      await tx.insert(payments).values({
        orderId: order!.id,
        provider: "fake",
        providerPaymentId: `demo_pay_${o.number}`,
        status: "succeeded",
        amountCents: quote.totalCents,
        succeededAt: o.placedAt,
      });
    }

    // Seed balance so the demo customer has one free drink to try (clearly labelled adjustment).
    const adjustment = 7 - earned;
    balance += adjustment;
    await tx.insert(loyaltyTransactions).values({
      accountId: account!.id,
      kind: "adjust",
      source: "staff",
      stamps: adjustment,
      balanceAfter: balance,
      idempotencyKey: "seed:adjust:demo-customer",
      programVersion: 1,
      details: { action: "stamps" },
      reason: "Development seed balance (demo data)",
    });
    balance -= 5;
    const [convert] = await tx
      .insert(loyaltyTransactions)
      .values({
        accountId: account!.id,
        kind: "convert",
        source: "staff",
        stamps: -5,
        balanceAfter: balance,
        idempotencyKey: "seed:adjust:demo-customer:convert:1",
        programVersion: 1,
      })
      .returning({ id: loyaltyTransactions.id });
    const [reward] = await tx
      .insert(rewards)
      .values({
        accountId: account!.id,
        sourceTransactionId: convert!.id,
        stampsCost: 5,
        programVersion: 1,
      })
      .returning({ id: rewards.id });
    await tx
      .update(loyaltyTransactions)
      .set({ rewardId: reward!.id })
      .where(eq(loyaltyTransactions.id, convert!.id));
    await updateBalance(tx, account!.id, balance, earned);

    const fav = pick("demo-latte", 1, ["Oat beverage"]);
    await tx.insert(favorites).values({
      userId: customerId,
      productId: fav.productId,
      variantId: fav.variantId,
      optionIds: [...fav.optionIds].sort(),
    });

    return {
      users: DEMO_USERS.length,
      categories: 2,
      products: PRODUCTS.length,
      orders: demoOrders.length,
    };
  });
}

async function updateBalance(tx: Tx, accountId: string, balance: number, lifetime: number) {
  await tx
    .update(loyaltyAccounts)
    .set({ stampBalance: balance, lifetimeStamps: lifetime })
    .where(eq(loyaltyAccounts.id, accountId));
}
