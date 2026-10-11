import { asc, inArray, isNull } from "drizzle-orm";
import type {
  ConfiguredGroup,
  ConfiguredOption,
  ConfiguredProduct,
  ConfiguredVariant,
} from "@ssc/domain";
import type { Database, Tx } from "../index";
import { modifierOptions, productModifierGroups, productVariants, products } from "../schema/index";

/** Menu configuration plus the display fields the storefront needs (both languages). */
export interface CatalogOption extends ConfiguredOption {
  nameFr: string;
  nameEn: string;
}
export interface CatalogGroup extends ConfiguredGroup {
  nameFr: string;
  nameEn: string;
  options: CatalogOption[];
}
export interface CatalogVariant extends ConfiguredVariant {
  nameFr: string;
  nameEn: string;
}
export interface CatalogProduct extends ConfiguredProduct {
  slug: string;
  nameFr: string;
  nameEn: string;
  descriptionFr: string | null;
  descriptionEn: string | null;
  imageUrl: string | null;
  imageAltFr: string | null;
  imageAltEn: string | null;
  allergenNoteFr: string | null;
  allergenNoteEn: string | null;
  isFeatured: boolean;
  isDemo: boolean;
  variants: CatalogVariant[];
  groups: CatalogGroup[];
}

/**
 * Loads products (optionally only `productIds`) with their non-archived variants, modifier groups
 * and options, in display order. Archived products are omitted; hidden ones are returned with
 * availability "hidden" so pricing can reject them explicitly.
 */
export async function loadCatalog(
  db: Database | Tx,
  productIds?: string[],
): Promise<Map<string, CatalogProduct>> {
  if (productIds?.length === 0) return new Map();
  const rows = await db.query.products.findMany({
    where: (p, { and }) =>
      productIds ? and(isNull(p.archivedAt), inArray(p.id, productIds)) : isNull(p.archivedAt),
    orderBy: [asc(products.sortOrder)],
    with: {
      variants: {
        where: (v) => isNull(v.archivedAt),
        orderBy: [asc(productVariants.sortOrder)],
      },
      modifierGroups: {
        orderBy: [asc(productModifierGroups.sortOrder)],
        with: {
          group: {
            with: {
              options: {
                where: (o) => isNull(o.archivedAt),
                orderBy: [asc(modifierOptions.sortOrder)],
              },
            },
          },
        },
      },
    },
  });

  return new Map(
    rows.map((p): [string, CatalogProduct] => [
      p.id,
      {
        id: p.id,
        categoryId: p.categoryId,
        slug: p.slug,
        nameFr: p.nameFr,
        nameEn: p.nameEn,
        descriptionFr: p.descriptionFr,
        descriptionEn: p.descriptionEn,
        imageUrl: p.imageUrl,
        imageAltFr: p.imageAltFr,
        imageAltEn: p.imageAltEn,
        allergenNoteFr: p.allergenNoteFr,
        allergenNoteEn: p.allergenNoteEn,
        availability: p.availability,
        taxCategory: p.taxCategory,
        isDrink: p.isDrink,
        loyaltyQualifying: p.loyaltyQualifying,
        rewardEligible: p.rewardEligible,
        isFeatured: p.isFeatured,
        isDemo: p.isDemo,
        variants: p.variants.map((v) => ({
          id: v.id,
          nameFr: v.nameFr,
          nameEn: v.nameEn,
          priceCents: v.priceCents,
          isDefault: v.isDefault,
          availability: v.availability,
        })),
        groups: p.modifierGroups
          .filter((link) => link.group.archivedAt === null)
          .map((link) => ({
            id: link.group.id,
            nameFr: link.group.nameFr,
            nameEn: link.group.nameEn,
            selection: link.group.selection,
            minSelected: link.group.minSelected,
            maxSelected: link.group.maxSelected,
            options: link.group.options.map((o) => ({
              id: o.id,
              nameFr: o.nameFr,
              nameEn: o.nameEn,
              priceDeltaCents: o.priceDeltaCents,
              isDefault: o.isDefault,
              availability: o.availability,
            })),
          })),
      },
    ]),
  );
}
