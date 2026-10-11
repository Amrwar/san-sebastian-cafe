import { asc, categories, isNull, ne, products, productVariants, type Database } from "@ssc/db";
import { withinWindows, type Availability, type UnavailableReason } from "@ssc/domain";

export interface MenuProduct {
  id: string;
  slug: string;
  nameFr: string;
  nameEn: string;
  descriptionFr: string | null;
  descriptionEn: string | null;
  imageUrl: string | null;
  imageAltFr: string | null;
  imageAltEn: string | null;
  isDrink: boolean;
  availability: Exclude<Availability, "hidden">;
  /** Why it can't be ordered right now (sold out, paused by staff, outside its hours). */
  unavailableReason: Exclude<UnavailableReason, "hidden"> | null;
  /** Weekly windows when it's offered (empty = whenever the café is open). */
  availabilityWindows: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  unavailableUntil: string | null;
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
export async function getPublishedMenu(db: Database, now = new Date()): Promise<MenuCategory[]> {
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
          availabilityWindows: true,
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
        const windows = p.availabilityWindows.map((w) => ({
          weekday: w.weekday,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        }));
        const unavailableReason: MenuProduct["unavailableReason"] =
          p.availability === "sold_out" || prices.length === 0
            ? "sold_out"
            : p.unavailableUntil && p.unavailableUntil > now
              ? "temporarily_unavailable"
              : !withinWindows(windows, now)
                ? "outside_hours"
                : null;
        return {
          id: p.id,
          slug: p.slug,
          nameFr: p.nameFr,
          nameEn: p.nameEn,
          descriptionFr: p.descriptionFr,
          descriptionEn: p.descriptionEn,
          imageUrl: p.imageUrl,
          imageAltFr: p.imageAltFr,
          imageAltEn: p.imageAltEn,
          isDrink: p.isDrink,
          availability: unavailableReason ? "sold_out" : "available",
          unavailableReason,
          availabilityWindows: windows,
          unavailableUntil:
            p.unavailableUntil && p.unavailableUntil > now
              ? p.unavailableUntil.toISOString()
              : null,
          fromPriceCents: prices.length > 0 ? Math.min(...prices) : null,
          modifierGroupCount: p.modifierGroups.length,
          isDemo: p.isDemo,
        };
      }),
    }))
    .filter((c) => c.products.length > 0);
}
