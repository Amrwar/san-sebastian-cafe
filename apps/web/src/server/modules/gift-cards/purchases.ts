import { randomBytes } from "node:crypto";
import {
  and,
  eq,
  giftCardPurchases,
  giftCards,
  giftCardTransactions,
  lt,
  outboxMessages,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  formatGiftCardCode,
  GIFT_CARD_ONLINE_MAX_CENTS,
  GIFT_CARD_ONLINE_MIN_CENTS,
  type CheckoutSnapshot,
  type PaymentProviderName,
} from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { env } from "../../env";
import { AppError, fromZodError, notFound, required, unprocessable } from "../../errors";
import { logger } from "../../logger";
import { hashToken } from "../ordering/place-order";
import { paymentProvider } from "../payments/provider";
import { newGiftCardCode } from "./gift-cards";
import { hashGiftCardCode, moveGiftCardBalance } from "./ledger";

/*
 * Gift cards bought on the site. The purchaser pays on the provider's hosted page; once the
 * provider confirms the money (verified webhook, or the return page's authenticated status check)
 * the card is issued and its code emailed to the recipient — the code is never stored, and is
 * erased from the queued email once sent. Selling a gift card is not a taxable sale.
 *
 * Money that can't buy a card (paid after the page expired, a second payment, a wrong amount) is
 * refunded automatically. Staff can refund a purchase while its card is still unused.
 */

type PurchaseRow = typeof giftCardPurchases.$inferSelect;

/** Same lifetime as an order's payment page (providers require at least 30 minutes). */
const CHECKOUT_LIFETIME_MS = 31 * 60_000;
/** Payments confirmed a little after the page closed still buy the card (provider delays). */
const LATE_GRACE_MS = 5 * 60_000;

export const purchaseInput = z.object({
  amountCents: z.number().int().min(GIFT_CARD_ONLINE_MIN_CENTS).max(GIFT_CARD_ONLINE_MAX_CENTS),
  recipientName: z.string().trim().min(1).max(80),
  recipientEmail: z.email().max(254),
  message: z.string().trim().max(300).optional(),
  purchaserName: z.string().trim().min(1).max(80),
  /** Guests only; signed-in customers use their account email. */
  purchaserEmail: z.email().max(254).optional(),
  locale: z.enum(["fr", "en"]),
});

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

const appOrigin = () => new URL(env().BETTER_AUTH_URL).origin;

/** Starts a purchase and opens the provider's payment page. Returns where to send the browser. */
export async function startPurchase(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  options: { provider: PaymentProviderName | "none"; now?: Date },
) {
  if (options.provider === "none")
    throw unprocessable("payments_unavailable", "Online payment is not available yet");
  const input = parse(purchaseInput, raw);
  const now = options.now ?? new Date();
  let purchaserEmail = input.purchaserEmail ?? null;
  if (actor) {
    const user = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, actor.userId) });
    purchaserEmail = user?.email ?? purchaserEmail;
  }
  if (!purchaserEmail) {
    throw new AppError("validation_failed", "Guests must provide an email", [
      { path: "purchaserEmail", code: "required" },
    ]);
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + CHECKOUT_LIFETIME_MS);
  const [created] = await db
    .insert(giftCardPurchases)
    .values({
      amountCents: input.amountCents,
      purchaserUserId: actor?.userId ?? null,
      purchaserName: input.purchaserName,
      purchaserEmail,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail,
      message: input.message || null,
      locale: input.locale === "en" ? "en-CA" : "fr-CA",
      accessTokenHash: hashToken(token),
      provider: options.provider,
      expiresAt,
      createdAt: now,
    })
    .returning();
  const purchase = required(created, "purchase");

  const base = `${appOrigin()}/${input.locale}/gift-cards/purchase/${purchase.id}?token=${encodeURIComponent(token)}`;
  const amount = new Intl.NumberFormat(input.locale === "en" ? "en-CA" : "fr-CA", {
    style: "currency",
    currency: "CAD",
  }).format(input.amountCents / 100);
  const checkout = await paymentProvider(options.provider).createCheckout({
    attemptId: purchase.id,
    kind: "gift_card",
    orderId: purchase.id,
    orderNumber: "",
    amountCents: input.amountCents,
    description:
      input.locale === "en"
        ? `${amount} gift card for ${input.recipientName} (no tax)`
        : `Carte-cadeau de ${amount} pour ${input.recipientName} (sans taxes)`,
    locale: input.locale,
    successUrl: `${base}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}&cancelled=1`,
    expiresAt,
    customerEmail: purchaserEmail,
    providerCustomerId: null,
  });
  await db
    .update(giftCardPurchases)
    .set({ providerSessionId: checkout.sessionId, checkoutUrl: checkout.url })
    .where(eq(giftCardPurchases.id, purchase.id));
  return { purchaseId: purchase.id, url: checkout.url, token };
}

/** A payment to give back after the transaction commits (it can't buy a card). */
interface PendingRefund {
  provider: PaymentProviderName;
  paymentId: string;
  amountCents: number;
}

/**
 * Applies the provider's answer for a purchase's payment page (caller's transaction). Issues the
 * card once; returns a refund to make when the money can't buy one. Unknown sessions: null.
 */
export async function applyPurchaseCheckout(
  tx: Tx,
  providerName: PaymentProviderName,
  snapshot: CheckoutSnapshot,
  now: Date,
): Promise<{
  outcome: "paid" | "duplicate" | "refund" | "pending";
  refund: PendingRefund | null;
} | null> {
  const [purchase] = await tx
    .select()
    .from(giftCardPurchases)
    .where(
      and(
        eq(giftCardPurchases.provider, providerName),
        eq(giftCardPurchases.providerSessionId, snapshot.sessionId),
      ),
    )
    .for("update");
  if (!purchase) return null;
  if (snapshot.payment !== "paid" || !snapshot.paymentId) {
    if (snapshot.status === "expired" && purchase.status === "awaiting_payment")
      await tx
        .update(giftCardPurchases)
        .set({ status: "expired" })
        .where(eq(giftCardPurchases.id, purchase.id));
    return { outcome: "pending", refund: null };
  }
  if (purchase.providerPaymentId === snapshot.paymentId)
    return { outcome: "duplicate", refund: null };

  // Paid in time (the page's lifetime plus a short grace for slow confirmations), for the right
  // amount in CAD, on a purchase still waiting for it.
  const inTime = now.getTime() <= purchase.expiresAt.getTime() + LATE_GRACE_MS;
  const usable =
    inTime &&
    (purchase.status === "awaiting_payment" || purchase.status === "expired") &&
    snapshot.amountCents === purchase.amountCents &&
    snapshot.currency?.toUpperCase() === "CAD";
  if (!usable) {
    logger().warn(
      { purchaseId: purchase.id, status: purchase.status, amountCents: snapshot.amountCents },
      "gift card purchase payment can't buy a card; refunding",
    );
    await recordAudit(tx, {
      actorUserId: null,
      action: "gift_card.purchase_payment_refunded",
      entityType: "gift_card_purchase",
      entityId: purchase.id,
      metadata: { amountCents: snapshot.amountCents, status: purchase.status },
    });
    return {
      outcome: "refund",
      refund: {
        provider: providerName,
        paymentId: snapshot.paymentId,
        amountCents: snapshot.amountCents ?? 0,
      },
    };
  }

  const code = newGiftCardCode();
  const [card] = await tx
    .insert(giftCards)
    .values({
      codeHash: hashGiftCardCode(code),
      codeLast4: code.slice(-4),
      initialCents: purchase.amountCents,
      balanceCents: 0,
      note: "Vendue en ligne / sold online",
      issuedAt: now,
    })
    .returning();
  const issued = required(card, "gift card");
  await moveGiftCardBalance(tx, issued.id, {
    kind: "issue",
    deltaCents: purchase.amountCents,
    actorUserId: purchase.purchaserUserId,
    note: "online purchase",
  });
  await tx
    .update(giftCardPurchases)
    .set({
      status: "paid",
      paidAt: now,
      providerPaymentId: snapshot.paymentId,
      giftCardId: issued.id,
      checkoutUrl: null,
    })
    .where(eq(giftCardPurchases.id, purchase.id));
  await queuePurchaseEmails(tx, purchase, code, issued.codeLast4, now);
  await recordAudit(tx, {
    actorUserId: purchase.purchaserUserId,
    action: "gift_card.sold_online",
    entityType: "gift_card",
    entityId: issued.id,
    metadata: { purchaseId: purchase.id, amountCents: purchase.amountCents },
  });
  return { outcome: "paid", refund: null };
}

/**
 * The card to the recipient (with its code: erased from the queue once sent) and a receipt to
 * the purchaser (without it).
 */
async function queuePurchaseEmails(
  tx: Tx,
  purchase: PurchaseRow,
  code: string,
  last4: string,
  now: Date,
) {
  const locale = purchase.locale === "en-CA" ? "en" : "fr";
  const common = {
    purchaseId: purchase.id,
    amountCents: purchase.amountCents,
    recipientName: purchase.recipientName,
    purchaserName: purchase.purchaserName,
  };
  await tx
    .insert(outboxMessages)
    .values([
      {
        channel: "email",
        template: "gift_card_delivery",
        recipient: purchase.recipientEmail,
        locale,
        payload: { ...common, code: formatGiftCardCode(code), message: purchase.message },
        dedupeKey: `gift_card_delivery:${purchase.id}`,
        // Due from the app's clock, like order notices (the database clock may be ahead).
        nextAttemptAt: now,
      },
      {
        channel: "email",
        template: "gift_card_receipt",
        recipient: purchase.purchaserEmail,
        locale,
        payload: { ...common, last4, recipientEmail: maskEmail(purchase.recipientEmail) },
        dedupeKey: `gift_card_receipt:${purchase.id}`,
        nextAttemptAt: now,
      },
    ])
    .onConflictDoNothing();
}

/** "camille@example.com" → "c•••••e@example.com": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (local.length <= 2) return `${local.slice(0, 1)}•@${domain}`;
  return `${local.slice(0, 1)}${"•".repeat(Math.min(5, local.length - 2))}${local.slice(-1)}@${domain}`;
}

/** Sends back money that couldn't buy a card (after commit; idempotent per payment). */
export async function refundPayment(refund: PendingRefund): Promise<void> {
  try {
    await paymentProvider(refund.provider).refund({
      paymentId: refund.paymentId,
      amountCents: refund.amountCents,
      idempotencyKey: `gift-card-purchase-${refund.paymentId}`,
      localRefundId: refund.paymentId,
      reason: "duplicate",
    });
  } catch (err) {
    // Logged for staff; the provider dashboard shows the payment to refund by hand.
    logger().error({ err, paymentId: refund.paymentId }, "gift card purchase refund failed");
  }
}

/** Webhook entry point: applies the answer and makes any refund once committed. */
export async function applyPurchaseCheckoutAndRefund(
  db: Database,
  providerName: PaymentProviderName,
  snapshot: CheckoutSnapshot,
  now = new Date(),
) {
  const applied = await db.transaction((tx) =>
    applyPurchaseCheckout(tx, providerName, snapshot, now),
  );
  if (applied?.refund) await refundPayment(applied.refund);
  return applied;
}

async function accessiblePurchase(
  db: Database,
  actor: Actor | null,
  id: string,
  token: string | null,
): Promise<PurchaseRow> {
  const purchase = z.uuid().safeParse(id).success
    ? await db.query.giftCardPurchases.findFirst({ where: eq(giftCardPurchases.id, id) })
    : undefined;
  const allowed =
    purchase &&
    ((token && purchase.accessTokenHash === hashToken(token)) ||
      (actor && purchase.purchaserUserId === actor.userId));
  if (!purchase || !allowed) throw notFound("Purchase");
  return purchase;
}

function view(p: PurchaseRow) {
  return {
    id: p.id,
    status: p.status,
    amountCents: p.amountCents,
    recipientName: p.recipientName,
    recipientEmail: maskEmail(p.recipientEmail),
    provider: p.provider,
    checkoutUrl: p.status === "awaiting_payment" ? p.checkoutUrl : null,
    expiresAt: p.expiresAt.toISOString(),
  };
}
export type PurchaseView = ReturnType<typeof view>;

/** Unpaid purchases whose page closed (with the grace period for late confirmations). */
async function expireStalePurchases(db: Database, now: Date) {
  await db
    .update(giftCardPurchases)
    .set({ status: "expired" })
    .where(
      and(
        eq(giftCardPurchases.status, "awaiting_payment"),
        lt(giftCardPurchases.expiresAt, new Date(now.getTime() - LATE_GRACE_MS)),
      ),
    );
}

/**
 * The return page's "is it paid yet?": asks the provider directly (authenticated) and applies the
 * answer, so the card doesn't wait for the webhook. The redirect itself proves nothing.
 */
export async function syncPurchase(
  db: Database,
  actor: Actor | null,
  id: string,
  token: string | null,
  now = new Date(),
): Promise<PurchaseView> {
  const purchase = await accessiblePurchase(db, actor, id, token);
  if (purchase.status === "awaiting_payment" && purchase.providerSessionId) {
    const snapshot = await paymentProvider(purchase.provider).getCheckout(
      purchase.providerSessionId,
    );
    await applyPurchaseCheckoutAndRefund(db, purchase.provider, snapshot, now);
  }
  await expireStalePurchases(db, now);
  return view(await accessiblePurchase(db, actor, id, token));
}

/** DEVELOPMENT SIMULATOR (PAYMENT_PROVIDER=fake): pays the purchase without moving money. */
export async function simulatePurchasePayment(
  db: Database,
  actor: Actor | null,
  id: string,
  token: string | null,
  now = new Date(),
): Promise<PurchaseView> {
  const purchase = await accessiblePurchase(db, actor, id, token);
  if (purchase.provider !== "fake" || !purchase.providerSessionId) throw notFound("Purchase");
  await applyPurchaseCheckoutAndRefund(
    db,
    "fake",
    {
      sessionId: purchase.providerSessionId,
      status: "complete",
      payment: "paid",
      paymentId: `fake_pi_${purchase.id}`,
      amountCents: purchase.amountCents,
      currency: "cad",
      orderId: purchase.id,
      card: { brand: "visa", last4: "4242" },
    },
    now,
  );
  return view(await accessiblePurchase(db, actor, id, token));
}

/**
 * Staff (shift lead+): refunds an online purchase whose card hasn't been used. The card is
 * emptied and blocked in the same transaction; the money goes back through the provider after.
 */
export async function refundPurchaseAsStaff(
  db: Database,
  actor: Actor | null,
  giftCardId: string,
  raw: unknown,
) {
  authorize(actor, "orders:refund");
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), raw);
  const purchase = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(giftCardPurchases)
      .where(eq(giftCardPurchases.giftCardId, giftCardId))
      .for("update");
    if (!row) throw notFound("Purchase");
    if (row.status !== "paid" || !row.providerPaymentId) throw unprocessable("refund_not_allowed");
    const [card] = await tx
      .select()
      .from(giftCards)
      .where(eq(giftCards.id, giftCardId))
      .for("update");
    const spent = await tx
      .select({ id: giftCardTransactions.id })
      .from(giftCardTransactions)
      .where(
        and(
          eq(giftCardTransactions.giftCardId, giftCardId),
          eq(giftCardTransactions.kind, "redeem"),
        ),
      )
      .limit(1);
    // Only an untouched card can be taken back: once used, its value has been spent.
    if (!card || card.balanceCents !== card.initialCents || spent.length > 0)
      throw unprocessable("gift_card_used", "The card has been used");
    await moveGiftCardBalance(tx, giftCardId, {
      kind: "adjustment",
      deltaCents: -card.balanceCents,
      actorUserId: actor.userId,
      note: `Achat remboursé / purchase refunded: ${reason}`,
    });
    await tx.update(giftCards).set({ status: "disabled" }).where(eq(giftCards.id, giftCardId));
    await tx
      .update(giftCardPurchases)
      .set({ status: "refunded", refundedAt: new Date() })
      .where(eq(giftCardPurchases.id, row.id));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "gift_card.purchase_refunded",
      entityType: "gift_card_purchase",
      entityId: row.id,
      metadata: { amountCents: row.amountCents, reason },
    });
    return row;
  });
  const refund = await paymentProvider(purchase.provider).refund({
    paymentId: required(purchase.providerPaymentId, "payment"),
    amountCents: purchase.amountCents,
    idempotencyKey: `gift-card-purchase-refund-${purchase.id}`,
    localRefundId: purchase.id,
    reason: "requested_by_customer",
  });
  await db
    .update(giftCardPurchases)
    .set({ providerRefundId: refund.refundId })
    .where(eq(giftCardPurchases.id, purchase.id));
  return { purchaseId: purchase.id, refundStatus: refund.status };
}

/** Whether a card was bought online, and so can be refunded through the provider while unused. */
export async function purchaseForCard(db: Database, giftCardId: string) {
  const purchase = await db.query.giftCardPurchases.findFirst({
    where: eq(giftCardPurchases.giftCardId, giftCardId),
  });
  return purchase ? { id: purchase.id, status: purchase.status } : null;
}
