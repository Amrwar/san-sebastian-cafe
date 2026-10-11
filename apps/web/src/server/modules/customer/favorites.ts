import { and, desc, eq, favorites, loadCatalog, type Database } from "@ssc/db";
import { validateSelection } from "@ssc/domain";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";

export const MAX_FAVORITES = 50;

export const favoriteInput = z.object({
  productId: z.uuid(),
  variantId: z.uuid(),
  optionIds: z.array(z.uuid()).max(30),
});

export interface FavoriteView {
  id: string;
  productId: string;
  variantId: string;
  optionIds: string[];
  slug: string | null;
  nameFr: string;
  nameEn: string;
  variantNameFr: string;
  variantNameEn: string;
  optionNamesFr: string[];
  optionNamesEn: string[];
  /** False when the product, size or an option is no longer orderable as saved. */
  orderable: boolean;
  isDemo: boolean;
}

export async function listFavorites(db: Database, actor: Actor | null): Promise<FavoriteView[]> {
  authorize(actor, "profile:read_own");
  const rows = await db
    .select()
    .from(favorites)
    .where(eq(favorites.userId, actor.userId))
    .orderBy(desc(favorites.createdAt));
  const catalog = await loadCatalog(db, [...new Set(rows.map((r) => r.productId))]);
  return rows.map((r) => {
    const product = catalog.get(r.productId);
    const variant = product?.variants.find((v) => v.id === r.variantId);
    const options =
      product?.groups.flatMap((g) => g.options).filter((o) => r.optionIds.includes(o.id)) ?? [];
    const orderable =
      !!product &&
      validateSelection(product, { variantId: r.variantId, optionIds: r.optionIds }, 1).length ===
        0;
    return {
      id: r.id,
      productId: r.productId,
      variantId: r.variantId,
      optionIds: r.optionIds,
      slug: product?.slug ?? null,
      nameFr: product?.nameFr ?? "",
      nameEn: product?.nameEn ?? "",
      variantNameFr: variant?.nameFr ?? "",
      variantNameEn: variant?.nameEn ?? "",
      optionNamesFr: options.map((o) => o.nameFr),
      optionNamesEn: options.map((o) => o.nameEn),
      orderable,
      isDemo: product?.isDemo ?? false,
    };
  });
}

/** Saves a configuration. Idempotent: saving the same configuration twice returns the existing one. */
export async function addFavorite(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
): Promise<{ id: string }> {
  authorize(actor, "profile:update_own");
  const parsed = favoriteInput.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = { ...parsed.data, optionIds: [...new Set(parsed.data.optionIds)].sort() };

  const product = (await loadCatalog(db, [input.productId])).get(input.productId);
  if (!product) throw notFound("Product");
  const issues = validateSelection(product, input, 1).filter(
    (i) => i.code !== "product_unavailable",
  );
  if (
    issues.some(
      (i) =>
        i.code === "variant_invalid" || i.code === "option_invalid" || i.code.startsWith("group_"),
    )
  ) {
    throw new AppError("validation_failed", "Configuration does not match the menu", [
      { path: "optionIds", code: issues[0]?.code ?? "invalid" },
    ]);
  }

  const existing = await db.query.favorites.findMany({
    where: eq(favorites.userId, actor.userId),
    columns: { id: true },
  });
  const [inserted] = await db
    .insert(favorites)
    .values({ userId: actor.userId, ...input })
    .onConflictDoNothing()
    .returning({ id: favorites.id });
  if (inserted) {
    if (existing.length >= MAX_FAVORITES) {
      await db.delete(favorites).where(eq(favorites.id, inserted.id));
      throw new AppError("conflict", "Favorite limit reached");
    }
    return inserted;
  }
  const [same] = await db
    .select({ id: favorites.id })
    .from(favorites)
    .where(
      and(
        eq(favorites.userId, actor.userId),
        eq(favorites.productId, input.productId),
        eq(favorites.variantId, input.variantId),
        eq(favorites.optionIds, input.optionIds),
      ),
    );
  if (!same) throw new AppError("internal", "Favorite insert conflicted but was not found");
  return same;
}

export async function removeFavorite(db: Database, actor: Actor | null, id: string): Promise<void> {
  authorize(actor, "profile:update_own");
  if (!z.uuid().safeParse(id).success) throw notFound("Favorite");
  const deleted = await db
    .delete(favorites)
    .where(and(eq(favorites.id, id), eq(favorites.userId, actor.userId)))
    .returning({ id: favorites.id });
  if (deleted.length === 0) throw notFound("Favorite");
}
