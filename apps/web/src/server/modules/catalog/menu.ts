import { asc, categories, isNull, ne, products, productVariants, type Database } from "@ssc/db";
import type { Availability } from "@ssc/domain";

export interface MenuProduct {
  id: string;
  slug: string;
  nameFr: string;
  nameEn: string;
  descriptionFr: string | null;
  descriptionEn: string | null;
  availability: Exclude<Availability, "hidden">;
  /** Lowest available variant price in cents (before options and taxes), or null if none. */
  fromPriceCents: number | null;
  modifierGroupCount: number;
  isDemo: boolean;
}

export interface MenuCategory {
  id: string;
  slug: string;
  nameFr: string;
  nameEn: string;
  isDemo: boolean;
  products: MenuProduct[];
}

/** Public, read-only menu: visible categories, non-hidden and non-archived products. */
export async function getPublishedMenu(db: Database): Promise<MenuCategory[]> {
  const rows = await db.query.categories.findMany({
    where: (c, { and, eq }) => and(eq(c.isVisible, true), isNull(c.archivedAt)),
    orderBy: [asc(categories.sortOrder), asc(categories.nameFr)],
    with: {
      products: {
        where: (p, { and }) => and(isNull(p.archivedAt), ne(p.availability, "hidden")),
        orderBy: [asc(products.sortOrder)],
        with: {
          variants: {
            where: (v, { and }) => and(isNull(v.archivedAt), ne(v.availability, "hidden")),
            orderBy: [asc(productVariants.sortOrder)],
          },
          modifierGroups: true,
        },
      },
    },
  });

  return rows
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      nameFr: c.nameFr,
      nameEn: c.nameEn,
      isDemo: c.isDemo,
      products: c.products.map((p): MenuProduct => {
        const prices = p.variants
          .filter((v) => v.availability === "available")
          .map((v) => v.priceCents);
        return {
          id: p.id,
          slug: p.slug,
          nameFr: p.nameFr,
          nameEn: p.nameEn,
          descriptionFr: p.descriptionFr,
          descriptionEn: p.descriptionEn,
          availability:
            p.availability === "sold_out" || prices.length === 0 ? "sold_out" : "available",
          fromPriceCents: prices.length > 0 ? Math.min(...prices) : null,
          modifierGroupCount: p.modifierGroups.length,
          isDemo: p.isDemo,
        };
      }),
    }))
    .filter((c) => c.products.length > 0);
}
