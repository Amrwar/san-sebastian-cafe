import {
  and,
  asc,
  categories,
  eq,
  inArray,
  isNull,
  modifierGroups,
  modifierOptions,
  productAvailabilityWindows,
  productModifierGroups,
  products,
  productVariants,
  sql,
  type Database,
  type Tx,
} from "@ssc/db";
import { AVAILABILITY, TAX_CATEGORIES, type Availability } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, required, unprocessable } from "../../errors";

/*
 * Menu administration (manager and above). Every change is audited. Nothing a past order points
 * to is deleted: products, sizes, options and categories are archived, and orders keep their own
 * name and price snapshots, so editing a price never changes an order already placed.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;
const name = (max = 80) => z.string().trim().min(1).max(max);
/** Optional text: blank becomes null. */
const note = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** URL-safe identifier from a name ("Café au lait" → "cafe-au-lait"). */
export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

async function uniqueSlug(
  tx: Tx,
  table: typeof products | typeof categories,
  base: string,
): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ slug: table.slug })
        .from(table)
        .where(sql`${table.slug} = ${base} or ${table.slug} like ${`${base}-%`}`)
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Field names whose value differs (shallow), for the audit trail. */
function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((k) => {
    const a = before[k];
    const b = after[k];
    return a instanceof Date || b instanceof Date ? false : JSON.stringify(a) !== JSON.stringify(b);
  });
}

// --- Overview -------------------------------------------------------------------------------------

export interface AdminMenuProduct {
  id: string;
  slug: string;
  nameFr: string;
  nameEn: string;
  availability: Availability;
  isDrink: boolean;
  isFeatured: boolean;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  hasImage: boolean;
  isDemo: boolean;
}

export interface AdminMenuCategory {
  id: string;
  slug: string;
  nameFr: string;
  nameEn: string;
  descriptionFr: string | null;
  descriptionEn: string | null;
  isVisible: boolean;
  isDemo: boolean;
  products: AdminMenuProduct[];
}

/** Every current category and product, hidden ones included, in menu order. */
export async function listAdminMenu(
  db: Database,
  actor: Actor | null,
): Promise<AdminMenuCategory[]> {
  authorize(actor, "catalog:manage");
  const [cats, prods, prices] = await Promise.all([
    db
      .select()
      .from(categories)
      .where(isNull(categories.archivedAt))
      .orderBy(asc(categories.sortOrder), asc(categories.nameFr)),
    db
      .select()
      .from(products)
      .where(isNull(products.archivedAt))
      .orderBy(asc(products.sortOrder), asc(products.nameFr)),
    db
      .select({
        productId: productVariants.productId,
        min: sql<number>`min(${productVariants.priceCents})::int`,
        max: sql<number>`max(${productVariants.priceCents})::int`,
      })
      .from(productVariants)
      .where(isNull(productVariants.archivedAt))
      .groupBy(productVariants.productId),
  ]);
  const range = new Map(prices.map((p) => [p.productId, p]));
  return cats.map((c) => ({
    id: c.id,
    slug: c.slug,
    nameFr: c.nameFr,
    nameEn: c.nameEn,
    descriptionFr: c.descriptionFr,
    descriptionEn: c.descriptionEn,
    isVisible: c.isVisible,
    isDemo: c.isDemo,
    products: prods
      .filter((p) => p.categoryId === c.id)
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        nameFr: p.nameFr,
        nameEn: p.nameEn,
        availability: p.availability,
        isDrink: p.isDrink,
        isFeatured: p.isFeatured,
        minPriceCents: range.get(p.id)?.min ?? null,
        maxPriceCents: range.get(p.id)?.max ?? null,
        hasImage: p.imageUrl !== null,
        isDemo: p.isDemo,
      })),
  }));
}

// --- Categories -----------------------------------------------------------------------------------

export const categoryInput = z
  .object({
    nameFr: name(60),
    nameEn: name(60),
    descriptionFr: note(300),
    descriptionEn: note(300),
    isVisible: z.boolean(),
  })
  .strict();

/** Creates (no id) or updates a category. */
export async function saveCategory(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  categoryId?: string,
): Promise<{ id: string }> {
  authorize(actor, "catalog:manage");
  const input = parse(categoryInput, raw);
  return db.transaction(async (tx) => {
    if (categoryId === undefined) {
      const [{ next } = { next: 0 }] = await tx
        .select({ next: sql<number>`coalesce(max(${categories.sortOrder}) + 1, 0)::int` })
        .from(categories);
      const [row] = await tx
        .insert(categories)
        .values({
          ...input,
          slug: await uniqueSlug(tx, categories, slugify(input.nameFr)),
          sortOrder: next,
        })
        .returning({ id: categories.id });
      const id = required(row, "category").id;
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "catalog.category_created",
        entityType: "category",
        entityId: id,
        metadata: { nameFr: input.nameFr },
      });
      return { id };
    }
    const before = isUuid(categoryId)
      ? await tx.query.categories.findFirst({
          where: and(eq(categories.id, categoryId), isNull(categories.archivedAt)),
        })
      : undefined;
    if (!before) throw notFound("Category");
    await tx.update(categories).set(input).where(eq(categories.id, categoryId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "catalog.category_updated",
      entityType: "category",
      entityId: categoryId,
      metadata: { changed: changedFields(before, input) },
    });
    return { id: categoryId };
  });
}

/** Archives an empty category (move or archive its products first). */
export async function archiveCategory(
  db: Database,
  actor: Actor | null,
  categoryId: string,
): Promise<void> {
  authorize(actor, "catalog:manage");
  if (!isUuid(categoryId)) throw notFound("Category");
  await db.transaction(async (tx) => {
    const [cat] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), isNull(categories.archivedAt)))
      .for("update");
    if (!cat) throw notFound("Category");
    const [inUse] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.categoryId, categoryId), isNull(products.archivedAt)))
      .limit(1);
    if (inUse) throw unprocessable("category_not_empty");
    await tx
      .update(categories)
      .set({ archivedAt: new Date() })
      .where(eq(categories.id, categoryId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "catalog.category_archived",
      entityType: "category",
      entityId: categoryId,
    });
  });
}

export const reorderInput = z
  .object({ ids: z.array(z.uuid()).min(1).max(200) })
  .strict()
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: "duplicate ids" });

/**
 * Sets the menu order of categories (no `categoryId`) or of one category's products. The list must
 * name exactly the current items, so a stale screen can't drop or duplicate one.
 */
export async function reorderMenu(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  categoryId?: string,
): Promise<void> {
  authorize(actor, "catalog:manage");
  const { ids } = parse(reorderInput, raw);
  if (categoryId !== undefined && !isUuid(categoryId)) throw notFound("Category");
  await db.transaction(async (tx) => {
    const table = categoryId === undefined ? categories : products;
    const current = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        categoryId === undefined
          ? isNull(categories.archivedAt)
          : and(eq(products.categoryId, categoryId), isNull(products.archivedAt)),
      )
      .for("update");
    const known = new Set(current.map((r) => r.id));
    if (known.size !== ids.length || ids.some((id) => !known.has(id))) {
      throw new AppError("conflict", "Menu changed meanwhile", [], "stale_order");
    }
    for (const [index, id] of ids.entries()) {
      await tx.update(table).set({ sortOrder: index }).where(eq(table.id, id));
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action:
        categoryId === undefined ? "catalog.categories_reordered" : "catalog.products_reordered",
      entityType: categoryId === undefined ? "menu" : "category",
      entityId: categoryId,
      metadata: { ids },
    });
  });
}

// --- Products -------------------------------------------------------------------------------------

const variantInput = z
  .object({
    id: z.uuid().optional(),
    nameFr: name(40),
    nameEn: name(40),
    priceCents: z.number().int().min(0).max(100_000),
    isDefault: z.boolean(),
  })
  .strict();

const windowInput = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((w) => w.startMinute < w.endMinute, { path: ["endMinute"], message: "before start" });

export const productInput = z
  .object({
    categoryId: z.uuid(),
    nameFr: name(80),
    nameEn: name(80),
    descriptionFr: note(500),
    descriptionEn: note(500),
    allergenNoteFr: note(500),
    allergenNoteEn: note(500),
    taxCategory: z.enum(TAX_CATEGORIES),
    isDrink: z.boolean(),
    isFeatured: z.boolean(),
    loyaltyQualifying: z.boolean(),
    rewardEligible: z.boolean(),
    availability: z.enum(AVAILABILITY),
    variants: z.array(variantInput).min(1).max(8),
    modifierGroupIds: z.array(z.uuid()).max(12),
    windows: z.array(windowInput).max(21),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!p.isDrink && p.loyaltyQualifying)
      ctx.addIssue({ code: "custom", path: ["loyaltyQualifying"], message: "drinks only" });
    if (!p.isDrink && p.rewardEligible)
      ctx.addIssue({ code: "custom", path: ["rewardEligible"], message: "drinks only" });
    if (p.variants.filter((v) => v.isDefault).length !== 1)
      ctx.addIssue({ code: "custom", path: ["variants"], message: "exactly one default" });
    const ids = p.variants.flatMap((v) => (v.id ? [v.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["variants"], message: "duplicate size" });
    if (new Set(p.modifierGroupIds).size !== p.modifierGroupIds.length)
      ctx.addIssue({ code: "custom", path: ["modifierGroupIds"], message: "duplicate group" });
  });
export type ProductInput = z.infer<typeof productInput>;

export interface AdminProduct extends Omit<ProductInput, "variants"> {
  id: string;
  slug: string;
  imageUrl: string | null;
  imageAltFr: string | null;
  imageAltEn: string | null;
  isDemo: boolean;
  variants: Array<
    Required<Pick<z.infer<typeof variantInput>, "id">> & z.infer<typeof variantInput>
  >;
}

/** One product as the edit form needs it (current sizes, groups in order, schedule). */
export async function getAdminProduct(
  db: Database,
  actor: Actor | null,
  productId: string,
): Promise<AdminProduct> {
  authorize(actor, "catalog:manage");
  const product = isUuid(productId)
    ? await db.query.products.findFirst({
        where: and(eq(products.id, productId), isNull(products.archivedAt)),
      })
    : undefined;
  if (!product) throw notFound("Product");
  const [variants, groups, windows] = await Promise.all([
    db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)))
      .orderBy(asc(productVariants.sortOrder)),
    db
      .select({ groupId: productModifierGroups.groupId })
      .from(productModifierGroups)
      .where(eq(productModifierGroups.productId, productId))
      .orderBy(asc(productModifierGroups.sortOrder)),
    db
      .select()
      .from(productAvailabilityWindows)
      .where(eq(productAvailabilityWindows.productId, productId))
      .orderBy(
        asc(productAvailabilityWindows.weekday),
        asc(productAvailabilityWindows.startMinute),
      ),
  ]);
  return {
    id: product.id,
    slug: product.slug,
    categoryId: product.categoryId,
    nameFr: product.nameFr,
    nameEn: product.nameEn,
    descriptionFr: product.descriptionFr,
    descriptionEn: product.descriptionEn,
    allergenNoteFr: product.allergenNoteFr,
    allergenNoteEn: product.allergenNoteEn,
    taxCategory: product.taxCategory,
    isDrink: product.isDrink,
    isFeatured: product.isFeatured,
    loyaltyQualifying: product.loyaltyQualifying,
    rewardEligible: product.rewardEligible,
    availability: product.availability,
    imageUrl: product.imageUrl,
    imageAltFr: product.imageAltFr,
    imageAltEn: product.imageAltEn,
    isDemo: product.isDemo,
    variants: variants.map((v) => ({
      id: v.id,
      nameFr: v.nameFr,
      nameEn: v.nameEn,
      priceCents: v.priceCents,
      isDefault: v.isDefault,
    })),
    modifierGroupIds: groups.map((g) => g.groupId),
    windows: windows.map((w) => ({
      weekday: w.weekday,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    })),
  };
}

/**
 * Creates (no id) or updates a product with its sizes, option groups and schedule. Sizes left out
 * are archived (past orders still point to them); a price change applies to new orders only.
 */
export async function saveProduct(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  productId?: string,
): Promise<{ id: string; slug: string }> {
  authorize(actor, "catalog:manage");
  const input = parse(productInput, raw);
  const { variants, modifierGroupIds, windows, ...fields } = input;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), isNull(categories.archivedAt)));
    if (!category) throw unknownId("categoryId");
    if (modifierGroupIds.length > 0) {
      const found = await tx
        .select({ id: modifierGroups.id })
        .from(modifierGroups)
        .where(
          and(inArray(modifierGroups.id, modifierGroupIds), isNull(modifierGroups.archivedAt)),
        );
      if (found.length !== modifierGroupIds.length) throw unknownId("modifierGroupIds");
    }

    let id: string;
    let slug: string;
    let changed: string[] = [];
    const priceChanges: Array<{ size: string; from: number | null; to: number }> = [];
    if (productId === undefined) {
      const [{ next } = { next: 0 }] = await tx
        .select({ next: sql<number>`coalesce(max(${products.sortOrder}) + 1, 0)::int` })
        .from(products)
        .where(eq(products.categoryId, input.categoryId));
      slug = await uniqueSlug(tx, products, slugify(input.nameFr));
      const [row] = await tx
        .insert(products)
        .values({ ...fields, slug, sortOrder: next })
        .returning({ id: products.id });
      id = required(row, "product").id;
    } else {
      const [before] = isUuid(productId)
        ? await tx
            .select()
            .from(products)
            .where(and(eq(products.id, productId), isNull(products.archivedAt)))
            .for("update")
        : [];
      if (!before) throw notFound("Product");
      id = productId;
      slug = before.slug;
      changed = changedFields(before, fields);
      // Moving to another category puts the product at the end of it.
      const moved =
        before.categoryId !== input.categoryId
          ? {
              sortOrder: sql`(select coalesce(max(${products.sortOrder}) + 1, 0) from ${products} where ${products.categoryId} = ${input.categoryId})`,
            }
          : {};
      await tx
        .update(products)
        .set({ ...fields, ...moved })
        .where(eq(products.id, id));
    }

    // Sizes: update kept ones, add new ones, archive the rest.
    const existing = await tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, id), isNull(productVariants.archivedAt)));
    const byId = new Map(existing.map((v) => [v.id, v]));
    for (const v of variants) {
      if (v.id && !byId.has(v.id)) throw unknownId("variants");
    }
    const kept = new Set(variants.flatMap((v) => (v.id ? [v.id] : [])));
    const dropped = existing.filter((v) => !kept.has(v.id));
    // Clear the default flag first: the one-default index is checked per statement.
    await tx
      .update(productVariants)
      .set({ isDefault: false })
      .where(eq(productVariants.productId, id));
    if (dropped.length > 0) {
      await tx
        .update(productVariants)
        .set({ archivedAt: now })
        .where(
          inArray(
            productVariants.id,
            dropped.map((v) => v.id),
          ),
        );
    }
    for (const [sortOrder, v] of variants.entries()) {
      const values = {
        nameFr: v.nameFr,
        nameEn: v.nameEn,
        priceCents: v.priceCents,
        isDefault: v.isDefault,
        sortOrder,
      };
      const before = v.id ? byId.get(v.id) : undefined;
      if (before) {
        if (before.priceCents !== v.priceCents)
          priceChanges.push({ size: v.nameFr, from: before.priceCents, to: v.priceCents });
        await tx.update(productVariants).set(values).where(eq(productVariants.id, before.id));
      } else {
        if (productId !== undefined)
          priceChanges.push({ size: v.nameFr, from: null, to: v.priceCents });
        await tx.insert(productVariants).values({ ...values, productId: id });
      }
    }

    // Option groups and schedule are replaced as a whole.
    await tx.delete(productModifierGroups).where(eq(productModifierGroups.productId, id));
    if (modifierGroupIds.length > 0) {
      await tx
        .insert(productModifierGroups)
        .values(
          modifierGroupIds.map((groupId, sortOrder) => ({ productId: id, groupId, sortOrder })),
        );
    }
    await tx.delete(productAvailabilityWindows).where(eq(productAvailabilityWindows.productId, id));
    if (windows.length > 0) {
      await tx
        .insert(productAvailabilityWindows)
        .values(windows.map((w) => ({ ...w, productId: id })));
    }

    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: productId === undefined ? "catalog.product_created" : "catalog.product_updated",
      entityType: "product",
      entityId: id,
      metadata: {
        nameFr: input.nameFr,
        ...(changed.length > 0 ? { changed } : {}),
        ...(priceChanges.length > 0 ? { priceChanges } : {}),
        ...(dropped.length > 0 ? { sizesArchived: dropped.map((v) => v.nameFr) } : {}),
      },
    });
    return { id, slug };
  });
}

function unknownId(path: string) {
  return new AppError("validation_failed", "Unknown reference", [{ path, code: "unknown_id" }]);
}

/** Removes a product from the menu for good (past orders keep their snapshots). */
export async function archiveProduct(
  db: Database,
  actor: Actor | null,
  productId: string,
): Promise<void> {
  authorize(actor, "catalog:manage");
  if (!isUuid(productId)) throw notFound("Product");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ archivedAt: new Date(), isFeatured: false })
      .where(and(eq(products.id, productId), isNull(products.archivedAt)))
      .returning({ nameFr: products.nameFr });
    if (!row) throw notFound("Product");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "catalog.product_archived",
      entityType: "product",
      entityId: productId,
      metadata: { nameFr: row.nameFr },
    });
  });
}

// --- Modifier groups ------------------------------------------------------------------------------

const optionInput = z
  .object({
    id: z.uuid().optional(),
    nameFr: name(60),
    nameEn: name(60),
    priceDeltaCents: z.number().int().min(-10_000).max(10_000),
    isDefault: z.boolean(),
  })
  .strict();

export const modifierGroupInput = z
  .object({
    nameFr: name(60),
    nameEn: name(60),
    selection: z.enum(["single", "multiple"]),
    minSelected: z.number().int().min(0).max(30),
    maxSelected: z.number().int().min(1).max(30),
    options: z.array(optionInput).min(1).max(30),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.selection === "single" && g.maxSelected !== 1)
      ctx.addIssue({ code: "custom", path: ["maxSelected"], message: "single choice" });
    if (g.minSelected > g.maxSelected)
      ctx.addIssue({ code: "custom", path: ["minSelected"], message: "above maximum" });
    if (g.maxSelected > g.options.length)
      ctx.addIssue({ code: "custom", path: ["maxSelected"], message: "more than options" });
    if (g.options.filter((o) => o.isDefault).length > g.maxSelected)
      ctx.addIssue({ code: "custom", path: ["options"], message: "too many defaults" });
    const ids = g.options.flatMap((o) => (o.id ? [o.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["options"], message: "duplicate option" });
  });
export type ModifierGroupInput = z.infer<typeof modifierGroupInput>;

export interface AdminModifierGroup extends Omit<ModifierGroupInput, "options"> {
  id: string;
  isDemo: boolean;
  usedBy: number;
  options: Array<z.infer<typeof optionInput> & { id: string }>;
}

export async function listModifierGroups(
  db: Database,
  actor: Actor | null,
): Promise<AdminModifierGroup[]> {
  authorize(actor, "catalog:manage");
  const [groups, options, usage] = await Promise.all([
    db
      .select()
      .from(modifierGroups)
      .where(isNull(modifierGroups.archivedAt))
      .orderBy(asc(modifierGroups.nameFr)),
    db
      .select()
      .from(modifierOptions)
      .where(isNull(modifierOptions.archivedAt))
      .orderBy(asc(modifierOptions.sortOrder)),
    db
      .select({ groupId: productModifierGroups.groupId, n: sql<number>`count(*)::int` })
      .from(productModifierGroups)
      .innerJoin(products, eq(products.id, productModifierGroups.productId))
      .where(isNull(products.archivedAt))
      .groupBy(productModifierGroups.groupId),
  ]);
  const used = new Map(usage.map((u) => [u.groupId, u.n]));
  return groups.map((g) => ({
    id: g.id,
    nameFr: g.nameFr,
    nameEn: g.nameEn,
    selection: g.selection,
    minSelected: g.minSelected,
    maxSelected: g.maxSelected,
    isDemo: g.isDemo,
    usedBy: used.get(g.id) ?? 0,
    options: options
      .filter((o) => o.groupId === g.id)
      .map((o) => ({
        id: o.id,
        nameFr: o.nameFr,
        nameEn: o.nameEn,
        priceDeltaCents: o.priceDeltaCents,
        isDefault: o.isDefault,
      })),
  }));
}

/** Creates (no id) or updates an option group; options left out are archived. */
export async function saveModifierGroup(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  groupId?: string,
): Promise<{ id: string }> {
  authorize(actor, "catalog:manage");
  const { options, ...fields } = parse(modifierGroupInput, raw);
  const now = new Date();
  return db.transaction(async (tx) => {
    let id: string;
    let changed: string[] = [];
    if (groupId === undefined) {
      const [row] = await tx
        .insert(modifierGroups)
        .values(fields)
        .returning({ id: modifierGroups.id });
      id = required(row, "modifier group").id;
    } else {
      const [before] = isUuid(groupId)
        ? await tx
            .select()
            .from(modifierGroups)
            .where(and(eq(modifierGroups.id, groupId), isNull(modifierGroups.archivedAt)))
            .for("update")
        : [];
      if (!before) throw notFound("Modifier group");
      id = groupId;
      changed = changedFields(before, fields);
      await tx.update(modifierGroups).set(fields).where(eq(modifierGroups.id, id));
    }

    const existing = await tx
      .select()
      .from(modifierOptions)
      .where(and(eq(modifierOptions.groupId, id), isNull(modifierOptions.archivedAt)));
    const byId = new Map(existing.map((o) => [o.id, o]));
    for (const o of options) if (o.id && !byId.has(o.id)) throw unknownId("options");
    const kept = new Set(options.flatMap((o) => (o.id ? [o.id] : [])));
    const dropped = existing.filter((o) => !kept.has(o.id));
    if (dropped.length > 0) {
      await tx
        .update(modifierOptions)
        .set({ archivedAt: now, isDefault: false })
        .where(
          inArray(
            modifierOptions.id,
            dropped.map((o) => o.id),
          ),
        );
    }
    const priceChanges: Array<{ option: string; from: number | null; to: number }> = [];
    for (const [sortOrder, o] of options.entries()) {
      const values = {
        nameFr: o.nameFr,
        nameEn: o.nameEn,
        priceDeltaCents: o.priceDeltaCents,
        isDefault: o.isDefault,
        sortOrder,
      };
      const before = o.id ? byId.get(o.id) : undefined;
      if (before) {
        if (before.priceDeltaCents !== o.priceDeltaCents)
          priceChanges.push({
            option: o.nameFr,
            from: before.priceDeltaCents,
            to: o.priceDeltaCents,
          });
        await tx.update(modifierOptions).set(values).where(eq(modifierOptions.id, before.id));
      } else {
        await tx.insert(modifierOptions).values({ ...values, groupId: id });
      }
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action:
        groupId === undefined ? "catalog.modifier_group_created" : "catalog.modifier_group_updated",
      entityType: "modifier_group",
      entityId: id,
      metadata: {
        nameFr: fields.nameFr,
        ...(changed.length > 0 ? { changed } : {}),
        ...(priceChanges.length > 0 ? { priceChanges } : {}),
        ...(dropped.length > 0 ? { optionsArchived: dropped.map((o) => o.nameFr) } : {}),
      },
    });
    return { id };
  });
}

/** Archives an option group no current product uses. */
export async function archiveModifierGroup(
  db: Database,
  actor: Actor | null,
  groupId: string,
): Promise<void> {
  authorize(actor, "catalog:manage");
  if (!isUuid(groupId)) throw notFound("Modifier group");
  await db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(and(eq(modifierGroups.id, groupId), isNull(modifierGroups.archivedAt)))
      .for("update");
    if (!group) throw notFound("Modifier group");
    const [inUse] = await tx
      .select({ id: products.id })
      .from(productModifierGroups)
      .innerJoin(products, eq(products.id, productModifierGroups.productId))
      .where(and(eq(productModifierGroups.groupId, groupId), isNull(products.archivedAt)))
      .limit(1);
    if (inUse) throw unprocessable("group_in_use");
    await tx
      .update(modifierGroups)
      .set({ archivedAt: new Date() })
      .where(eq(modifierGroups.id, groupId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "catalog.modifier_group_archived",
      entityType: "modifier_group",
      entityId: groupId,
    });
  });
}
