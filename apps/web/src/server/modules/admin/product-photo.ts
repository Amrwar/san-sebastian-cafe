import { randomBytes } from "node:crypto";
import { and, eq, isNull, products, type Database } from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";
import { detectImageType, IMAGE_TYPES } from "../../image-type";
import { logger } from "../../logger";
import type { FileStorage } from "../../storage";

/*
 * Product photos (manager and above). A photo always comes with French and English alt text. The
 * file is stored first and the product row then points to it; a replaced or removed photo is
 * deleted from storage only after the change commits, so the menu never shows a broken image.
 */

/** Below Vercel's 4.5 MB request limit, with room for the form fields. */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export const photoAltInput = z
  .object({
    imageAltFr: z.string().trim().min(1).max(200),
    imageAltEn: z.string().trim().min(1).max(200),
  })
  .strict();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

function invalidFile(code: "too_large" | "unsupported_type" | "empty" | "required") {
  return new AppError("validation_failed", "Invalid photo", [{ path: "file", code }]);
}

/** Deletes a file this storage holds; a failure only leaves an orphan, so it is logged. */
async function discard(storage: FileStorage, url: string | null): Promise<void> {
  if (!url || !storage.owns(url)) return;
  try {
    await storage.remove(url);
  } catch (err) {
    logger().warn({ err, url }, "could not delete stored photo");
  }
}

/**
 * Sets a product's photo and its alt text. Without a file, only the alt text changes (the product
 * must already have a photo).
 */
export async function setProductPhoto(
  db: Database,
  storage: FileStorage,
  actor: Actor | null,
  productId: string,
  raw: { file: Uint8Array | null; imageAltFr?: unknown; imageAltEn?: unknown },
): Promise<{ imageUrl: string }> {
  authorize(actor, "catalog:manage");
  const alt = photoAltInput.safeParse({ imageAltFr: raw.imageAltFr, imageAltEn: raw.imageAltEn });
  if (!alt.success) throw fromZodError(alt.error);
  if (!isUuid(productId)) throw notFound("Product");

  let uploaded: string | null = null;
  if (raw.file) {
    if (raw.file.byteLength === 0) throw invalidFile("empty");
    if (raw.file.byteLength > PHOTO_MAX_BYTES) throw invalidFile("too_large");
    const type = detectImageType(raw.file);
    if (!type) throw invalidFile("unsupported_type");
    const [product] = await db
      .select({ slug: products.slug })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.archivedAt)));
    if (!product) throw notFound("Product");
    const { contentType, extension } = IMAGE_TYPES[type];
    const key = `products/${productId}/${product.slug}-${randomBytes(6).toString("hex")}.${extension}`;
    uploaded = (await storage.put(key, raw.file, contentType)).url;
  }

  try {
    const { imageUrl, replaced } = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ nameFr: products.nameFr, imageUrl: products.imageUrl })
        .from(products)
        .where(and(eq(products.id, productId), isNull(products.archivedAt)))
        .for("update");
      if (!before) throw notFound("Product");
      const url = uploaded ?? before.imageUrl;
      if (!url) throw invalidFile("required");
      await tx
        .update(products)
        .set({ imageUrl: url, ...alt.data })
        .where(eq(products.id, productId));
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "catalog.product_photo_set",
        entityType: "product",
        entityId: productId,
        metadata: {
          nameFr: before.nameFr,
          photo: !uploaded ? "alt_text_only" : before.imageUrl ? "replaced" : "added",
        },
      });
      return { imageUrl: url, replaced: uploaded ? before.imageUrl : null };
    });
    await discard(storage, replaced);
    return { imageUrl };
  } catch (error) {
    await discard(storage, uploaded);
    throw error;
  }
}

/** Removes a product's photo; the menu shows the illustration again. */
export async function removeProductPhoto(
  db: Database,
  storage: FileStorage,
  actor: Actor | null,
  productId: string,
): Promise<void> {
  authorize(actor, "catalog:manage");
  if (!isUuid(productId)) throw notFound("Product");
  const removed = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ nameFr: products.nameFr, imageUrl: products.imageUrl })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.archivedAt)))
      .for("update");
    if (!before) throw notFound("Product");
    if (!before.imageUrl) return null;
    await tx
      .update(products)
      .set({ imageUrl: null, imageAltFr: null, imageAltEn: null })
      .where(eq(products.id, productId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "catalog.product_photo_removed",
      entityType: "product",
      entityId: productId,
      metadata: { nameFr: before.nameFr },
    });
    return before.imageUrl;
  });
  await discard(storage, removed);
}
