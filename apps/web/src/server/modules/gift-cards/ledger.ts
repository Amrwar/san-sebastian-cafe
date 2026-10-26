import { createHash } from "node:crypto";
import {
  and,
  eq,
  giftCards,
  giftCardTransactions,
  gte,
  inArray,
  sql,
  type Database,
  type Tx,
} from "@ssc/db";
import { normalizeGiftCardCode, type GiftCardTransactionKind } from "@ssc/domain";
import { required, unprocessable } from "../../errors";

/*
 * Gift card balance changes. The balance lives on the card; every change is written to
 * gift_card_transactions in the same transaction with a guarded update, so a balance can never go
 * below zero even when the card is used twice at once. Codes are looked up by their hash only.
 */

type GiftCardRow = typeof giftCards.$inferSelect;

export function hashGiftCardCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex");
}

/** The card with this code (typed by a person: case, spaces and dashes don't matter). */
export async function findGiftCard(
  db: Database | Tx,
  rawCode: string,
  options: { lock?: boolean } = {},
): Promise<GiftCardRow | undefined> {
  const code = normalizeGiftCardCode(rawCode);
  if (!code) return undefined;
  const query = db
    .select()
    .from(giftCards)
    .where(eq(giftCards.codeHash, hashGiftCardCode(code)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row;
}

/** The card for a purchase: it must exist and be active. Throws 422 otherwise. */
export async function usableGiftCard(tx: Tx, rawCode: string): Promise<GiftCardRow> {
  const card = await findGiftCard(tx, rawCode, { lock: true });
  if (!card) throw unprocessable("gift_card_invalid", "Unknown gift card");
  if (card.status !== "active") throw unprocessable("gift_card_disabled", "Gift card disabled");
  return card;
}

/**
 * Adds `deltaCents` (negative to spend) and records why. Spending more than the balance throws
 * 422 `gift_card_insufficient` and changes nothing.
 */
export async function moveGiftCardBalance(
  tx: Tx,
  giftCardId: string,
  movement: {
    kind: GiftCardTransactionKind;
    deltaCents: number;
    orderId?: string | null;
    refundId?: string | null;
    actorUserId?: string | null;
    note?: string | null;
  },
): Promise<number> {
  const [row] = await tx
    .update(giftCards)
    .set({ balanceCents: sql`${giftCards.balanceCents} + ${movement.deltaCents}` })
    .where(and(eq(giftCards.id, giftCardId), gte(giftCards.balanceCents, -movement.deltaCents)))
    .returning({ balance: giftCards.balanceCents });
  if (!row) throw unprocessable("gift_card_insufficient", "Not enough on the gift card");
  await tx.insert(giftCardTransactions).values({
    giftCardId,
    kind: movement.kind,
    deltaCents: movement.deltaCents,
    balanceAfterCents: row.balance,
    orderId: movement.orderId ?? null,
    refundId: movement.refundId ?? null,
    actorUserId: movement.actorUserId ?? null,
    note: movement.note ?? null,
  });
  return row.balance;
}

/**
 * Gives back what an unpaid order still holds on its card (its redemption minus earlier
 * releases), when the order expires or is cancelled before payment. Safe to call twice.
 */
export async function releaseOrderGiftCard(
  tx: Tx,
  orderId: string,
  actorUserId: string | null,
): Promise<void> {
  const held = await tx
    .select({
      giftCardId: giftCardTransactions.giftCardId,
      cents: sql<number>`(-sum(${giftCardTransactions.deltaCents}))::int`,
    })
    .from(giftCardTransactions)
    .where(
      and(
        eq(giftCardTransactions.orderId, orderId),
        inArray(giftCardTransactions.kind, ["redeem", "release"]),
      ),
    )
    .groupBy(giftCardTransactions.giftCardId)
    .having(sql`sum(${giftCardTransactions.deltaCents}) < 0`);
  for (const h of held) {
    await moveGiftCardBalance(tx, h.giftCardId, {
      kind: "release",
      deltaCents: h.cents,
      orderId,
      actorUserId,
    });
  }
}

/** Gift card money already given back for this order (succeeded refunds to the card). */
export async function giftCardRefundedCents(tx: Tx, orderId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${giftCardTransactions.deltaCents}), 0)::int` })
    .from(giftCardTransactions)
    .where(and(eq(giftCardTransactions.orderId, orderId), eq(giftCardTransactions.kind, "refund")));
  return required(row, "sum").cents;
}
