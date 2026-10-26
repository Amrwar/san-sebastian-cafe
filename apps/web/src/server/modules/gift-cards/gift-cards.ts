import { randomBytes } from "node:crypto";
import {
  and,
  desc,
  eq,
  giftCards,
  giftCardTransactions,
  orders,
  sql,
  users,
  type Database,
} from "@ssc/db";
import {
  formatGiftCardCode,
  GIFT_CARD_MAX_CENTS,
  GIFT_CARD_MIN_CENTS,
  giftCardCodeFromBytes,
} from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound, required, unprocessable } from "../../errors";
import { findGiftCard, hashGiftCardCode, moveGiftCardBalance } from "./ledger";

/*
 * Gift cards at the counter (Québec: no expiry, no fees). A card is issued once it has been paid
 * at the counter (the café's POS records that sale; no GST/QST on a gift card). Its code is shown
 * once and only its hash is kept. Customers check their balance on the site and pay with the card
 * online or at the counter. Every change is in the ledger and the audit log.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

function newCode(): string {
  for (;;) {
    const code = giftCardCodeFromBytes(randomBytes(64));
    if (code) return code;
  }
}

export const issueInput = z.object({
  amountCents: z.number().int().min(GIFT_CARD_MIN_CENTS).max(GIFT_CARD_MAX_CENTS),
  /** Staff note (e.g. the POS receipt number). Never customer data. */
  note: z.string().trim().max(200).optional(),
});

/** Issues a card paid at the counter. Returns the code: shown once, never stored. */
export async function issueGiftCard(db: Database, actor: Actor | null, raw: unknown) {
  authorize(actor, "gift_cards:issue");
  const input = parse(issueInput, raw);
  const code = newCode();
  return db.transaction(async (tx) => {
    const [card] = await tx
      .insert(giftCards)
      .values({
        codeHash: hashGiftCardCode(code),
        codeLast4: code.slice(-4),
        initialCents: input.amountCents,
        balanceCents: 0,
        issuedByUserId: actor.userId,
        note: input.note || null,
      })
      .returning();
    const issued = required(card, "gift card");
    const balance = await moveGiftCardBalance(tx, issued.id, {
      kind: "issue",
      deltaCents: input.amountCents,
      actorUserId: actor.userId,
      note: input.note || null,
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "gift_card.issued",
      entityType: "gift_card",
      entityId: issued.id,
      metadata: { amountCents: input.amountCents, last4: issued.codeLast4 },
    });
    return {
      id: issued.id,
      code: formatGiftCardCode(code),
      last4: issued.codeLast4,
      balanceCents: balance,
    };
  });
}

const codeInput = z.object({ code: z.string().trim().min(1).max(40) });

/** Public balance check: what is left and whether the card can be used. Nothing else. */
export async function checkGiftCardBalance(db: Database, raw: unknown) {
  const { code } = parse(codeInput, raw);
  const card = await findGiftCard(db, code);
  if (!card) throw notFound("Gift card");
  return { last4: card.codeLast4, balanceCents: card.balanceCents, status: card.status };
}

async function cardView(db: Database, id: string) {
  const card = await db.query.giftCards.findFirst({ where: eq(giftCards.id, id) });
  if (!card) throw notFound("Gift card");
  const history = await db
    .select({
      id: giftCardTransactions.id,
      kind: giftCardTransactions.kind,
      deltaCents: giftCardTransactions.deltaCents,
      balanceAfterCents: giftCardTransactions.balanceAfterCents,
      note: giftCardTransactions.note,
      createdAt: giftCardTransactions.createdAt,
      orderNumber: orders.number,
      actorName: users.name,
    })
    .from(giftCardTransactions)
    .leftJoin(orders, eq(orders.id, giftCardTransactions.orderId))
    .leftJoin(users, eq(users.id, giftCardTransactions.actorUserId))
    .where(eq(giftCardTransactions.giftCardId, id))
    .orderBy(desc(giftCardTransactions.createdAt), desc(giftCardTransactions.id))
    .limit(100);
  return {
    id: card.id,
    last4: card.codeLast4,
    initialCents: card.initialCents,
    balanceCents: card.balanceCents,
    status: card.status,
    issuedAt: card.issuedAt.toISOString(),
    note: card.note,
    history: history.map((h) => ({
      ...h,
      // Online purchases are by customers: only staff names are shown.
      actorName: h.orderNumber ? null : h.actorName,
      createdAt: h.createdAt.toISOString(),
    })),
  };
}

/** Staff: the card with this code, with its history. */
export async function lookupGiftCard(db: Database, actor: Actor | null, raw: unknown) {
  authorize(actor, "gift_cards:redeem");
  const { code } = parse(codeInput, raw);
  const card = await findGiftCard(db, code);
  if (!card) throw notFound("Gift card");
  return cardView(db, card.id);
}

export const redeemInput = z.object({
  amountCents: z.number().int().positive().max(GIFT_CARD_MAX_CENTS),
  note: z.string().trim().max(200).optional(),
});

/** Staff: pays a counter purchase with the card (the POS rings the sale as paid by gift card). */
export async function redeemAtCounter(db: Database, actor: Actor | null, id: string, raw: unknown) {
  authorize(actor, "gift_cards:redeem");
  const input = parse(redeemInput, raw);
  await db.transaction(async (tx) => {
    const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, id)).for("update");
    if (!card) throw notFound("Gift card");
    if (card.status !== "active") throw unprocessable("gift_card_disabled", "Gift card disabled");
    await moveGiftCardBalance(tx, id, {
      kind: "redeem",
      deltaCents: -input.amountCents,
      actorUserId: actor.userId,
      note: input.note || null,
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "gift_card.redeemed_at_counter",
      entityType: "gift_card",
      entityId: id,
      metadata: { amountCents: input.amountCents },
    });
  });
  return cardView(db, id);
}

export const statusInput = z.object({
  status: z.enum(["active", "disabled"]),
  reason: z.string().trim().min(3).max(200),
});

/** Shift lead: blocks a card (e.g. reported lost) or unblocks it. The balance is kept. */
export async function setGiftCardStatus(
  db: Database,
  actor: Actor | null,
  id: string,
  raw: unknown,
) {
  authorize(actor, "gift_cards:issue");
  const input = parse(statusInput, raw);
  await db.transaction(async (tx) => {
    const [card] = await tx
      .update(giftCards)
      .set({ status: input.status })
      .where(eq(giftCards.id, id))
      .returning({ id: giftCards.id });
    if (!card) throw notFound("Gift card");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: input.status === "disabled" ? "gift_card.disabled" : "gift_card.enabled",
      entityType: "gift_card",
      entityId: id,
      metadata: { reason: input.reason },
    });
  });
  return cardView(db, id);
}

export const adjustInput = z.object({
  /** Added (positive) or removed (negative); never below a zero balance. */
  deltaCents: z
    .number()
    .int()
    .min(-GIFT_CARD_MAX_CENTS)
    .max(GIFT_CARD_MAX_CENTS)
    .refine((n) => n !== 0, "Must not be zero"),
  reason: z.string().trim().min(3).max(200),
});

/** Manager: corrects a balance (with a reason). */
export async function adjustGiftCard(db: Database, actor: Actor | null, id: string, raw: unknown) {
  authorize(actor, "gift_cards:adjust");
  const input = parse(adjustInput, raw);
  await db.transaction(async (tx) => {
    const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, id)).for("update");
    if (!card) throw notFound("Gift card");
    await moveGiftCardBalance(tx, id, {
      kind: "adjustment",
      deltaCents: input.deltaCents,
      actorUserId: actor.userId,
      note: input.reason,
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "gift_card.adjusted",
      entityType: "gift_card",
      entityId: id,
      metadata: { deltaCents: input.deltaCents, reason: input.reason },
    });
  });
  return cardView(db, id);
}

/**
 * What the café owes on gift cards (outstanding balances, a liability until spent) and what moved
 * in [from, to): cards issued and amounts redeemed (net of releases and refunds back to cards).
 */
/** A bound: an instant, or a SQL expression (reports use local-day boundaries). */
type Bound = Date | ReturnType<typeof sql>;

export async function giftCardLiability(db: Database, fromBound: Bound, toBound: Bound) {
  // Raw SQL parameters take text, not dates.
  const from = fromBound instanceof Date ? fromBound.toISOString() : fromBound;
  const to = toBound instanceof Date ? toBound.toISOString() : toBound;
  const [outstanding] = await db
    .select({
      cents: sql<number>`coalesce(sum(${giftCards.balanceCents}), 0)::int`,
      cards: sql<number>`count(*) filter (where ${giftCards.balanceCents} > 0)::int`,
    })
    .from(giftCards);
  const moved = await db
    .select({
      kind: giftCardTransactions.kind,
      cents: sql<number>`coalesce(sum(${giftCardTransactions.deltaCents}), 0)::int`,
    })
    .from(giftCardTransactions)
    .where(
      and(
        sql`${giftCardTransactions.createdAt} >= ${from}`,
        sql`${giftCardTransactions.createdAt} < ${to}`,
      ),
    )
    .groupBy(giftCardTransactions.kind);
  const sum = (kind: string) => moved.find((m) => m.kind === kind)?.cents ?? 0;
  return {
    outstandingCents: required(outstanding, "sum").cents,
    cardsWithBalance: required(outstanding, "sum").cards,
    issuedCents: sum("issue"),
    // Spent net of what came back (unpaid orders released, refunds to the card).
    redeemedCents: -(sum("redeem") + sum("release") + sum("refund")),
    adjustedCents: sum("adjustment"),
  };
}
