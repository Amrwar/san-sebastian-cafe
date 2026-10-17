import { randomInt } from "node:crypto";
import { and, eq, gt, loyaltyCardCodes, lte, type Database } from "@ssc/db";
import { CARD_CODE_ALPHABET, CARD_CODE_LENGTH, CARD_CODE_TTL_MS } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";

/** Keep showing the same code while it still has this long to live. */
const REUSE_MARGIN_MS = 2 * 60_000;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CARD_CODE_LENGTH; i++)
    code += CARD_CODE_ALPHABET.charAt(randomInt(CARD_CODE_ALPHABET.length));
  return code;
}

/**
 * The code the signed-in customer shows at the counter (as a QR code or read aloud). It expires
 * after a few minutes, identifies the customer only, and carries no balance or permission.
 */
export async function issueCardCode(
  db: Database,
  actor: Actor | null,
  now = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  authorize(actor, "loyalty:read_own");
  const [current] = await db
    .select()
    .from(loyaltyCardCodes)
    .where(
      and(
        eq(loyaltyCardCodes.userId, actor.userId),
        gt(loyaltyCardCodes.expiresAt, new Date(now.getTime() + REUSE_MARGIN_MS)),
      ),
    )
    .limit(1);
  if (current) return { code: current.code, expiresAt: current.expiresAt };

  await db
    .delete(loyaltyCardCodes)
    .where(and(eq(loyaltyCardCodes.userId, actor.userId), lte(loyaltyCardCodes.expiresAt, now)));
  const expiresAt = new Date(now.getTime() + CARD_CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db
      .insert(loyaltyCardCodes)
      .values({ code: randomCode(), userId: actor.userId, expiresAt, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (row) return { code: row.code, expiresAt: row.expiresAt };
  }
  throw new Error("Could not allocate a card code");
}
