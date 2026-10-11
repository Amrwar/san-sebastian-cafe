import { loadCatalog, type CatalogProduct, type Database } from "@ssc/db";
import { getPublishedMenu, type MenuCategory, type MenuProduct } from "./menu";

/** Lower-case, accent-insensitive form used for search ("café" matches "cafe"). */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export interface MenuQuery {
  q?: string | undefined;
  category?: string | undefined;
}

/** Published menu filtered by category slug and/or a bilingual, accent-insensitive search. */
export async function searchMenu(db: Database, query: MenuQuery): Promise<MenuCategory[]> {
  const menu = await getPublishedMenu(db);
  const terms = normalizeSearch(query.q ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const matches = (p: MenuProduct) => {
    if (terms.length === 0) return true;
    const haystack = normalizeSearch(
      [p.nameFr, p.nameEn, p.descriptionFr ?? "", p.descriptionEn ?? ""].join(" "),
    );
    return terms.every((t) => haystack.includes(t));
  };
  return menu
    .filter((c) => !query.category || c.slug === query.category)
    .map((c) => ({ ...c, products: c.products.filter(matches) }))
    .filter((c) => c.products.length > 0);
}

export async function listCategories(db: Database) {
  const menu = await getPublishedMenu(db);
  return menu.map((c) => ({ slug: c.slug, nameFr: c.nameFr, nameEn: c.nameEn }));
}

export async function getFeaturedProducts(db: Database, limit = 6): Promise<MenuProduct[]> {
  const menu = await getPublishedMenu(db);
  const featuredIds = new Set(
    [...(await loadCatalog(db)).values()].filter((p) => p.isFeatured).map((p) => p.id),
  );
  return menu
    .flatMap((c) => c.products)
    .filter((p) => featuredIds.has(p.id))
    .slice(0, limit);
}

export interface ProductDetail extends CatalogProduct {
  category: { slug: string; nameFr: string; nameEn: string };
}

/** Full configuration of one visible product, or null (hidden, archived or unknown). */
export async function getProductBySlug(db: Database, slug: string): Promise<ProductDetail | null> {
  const row = await db.query.products.findFirst({
    where: (p, { and, eq, isNull: isNullOp, ne }) =>
      and(eq(p.slug, slug), isNullOp(p.archivedAt), ne(p.availability, "hidden")),
    columns: { id: true, categoryId: true },
  });
  if (!row) return null;
  const [product] = (await loadCatalog(db, [row.id])).values();
  const category = await db.query.categories.findFirst({
    where: (c, { eq }) => eq(c.id, row.categoryId),
    columns: { slug: true, nameFr: true, nameEn: true, isVisible: true, archivedAt: true },
  });
  if (!product || !category?.isVisible || category.archivedAt) return null;
  return {
    ...product,
    category: { slug: category.slug, nameFr: category.nameFr, nameEn: category.nameEn },
  };
}
