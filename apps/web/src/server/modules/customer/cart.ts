import { carts, eq, sql, type Database } from "@ssc/db";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError } from "../../errors";
import { cartLineInput } from "../ordering/cart-quote";

export const savedCartInput = z.object({
  lines: z.array(cartLineInput).max(30),
  /** Version the client last saw; a mismatch means another device changed the cart (409). */
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type SavedCartLine = z.infer<typeof cartLineInput>;

export interface SavedCart {
  lines: SavedCartLine[];
  version: number;
}

/** The signed-in customer's saved cart (ids and quantities only — re-priced on every read). */
export async function getSavedCart(db: Database, actor: Actor | null): Promise<SavedCart> {
  authorize(actor, "profile:read_own");
  const row = await db.query.carts.findFirst({ where: eq(carts.userId, actor.userId) });
  if (!row) return { lines: [], version: 0 };
  // Stored data is re-validated: anything malformed is dropped rather than trusted.
  const parsed = z.array(cartLineInput).safeParse(row.lines);
  return { lines: parsed.success ? parsed.data : [], version: row.version };
}

/** Replaces the saved cart. Optimistic concurrency across devices via `expectedVersion`. */
export async function saveCart(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<SavedCart> {
  authorize(actor, "profile:update_own");
  const parsed = savedCartInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const { lines, expectedVersion } = parsed.data;

  const [row] = await db
    .insert(carts)
    .values({ userId: actor.userId, lines, version: 1 })
    .onConflictDoUpdate({
      target: carts.userId,
      set: { lines, version: sql`${carts.version} + 1` },
      ...(expectedVersion !== undefined ? { setWhere: eq(carts.version, expectedVersion) } : {}),
    })
    .returning({ version: carts.version });
  if (!row)
    throw new AppError("conflict", "Cart changed on another device", [], "cart_version_conflict");
  return { lines, version: row.version };
}
