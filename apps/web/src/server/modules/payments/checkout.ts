import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  orders,
  paymentAttempts,
  paymentCustomers,
  payments,
  users,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  amountDueCents,
  checkoutOutcome,
  classifyIncomingPayment,
  customerPaymentState,
  LIVE_ATTEMPT_STATUSES,
  type CheckoutSnapshot,
  type CustomerPaymentState,
  type OrderStatus,
  type PaymentReconciliation,
} from "@ssc/domain";
import type { Actor } from "../../authz";
import { env } from "../../env";
import { notFound, required, unprocessable } from "../../errors";
import { logger } from "../../logger";
import {
  applyTransition,
  expireStaleOrders,
  lockOrder,
  recordOrderEvent,
  type OrderActor,
} from "../ordering/lifecycle";
import { resolveOrderAccess } from "../ordering/order-access";
import { loadStoreConfig } from "../store/pickup";
import { checkoutProvider, paymentProvider, type PaymentProvider } from "./provider";
import { primaryPayment, requestRefund, submitRefunds } from "./refunds";

/*
 * Paying for an order:
 *   startCheckout  → one hosted payment page per order (reused while open, so a customer is never
 *                    sent to two pages for the same order), created server-side for the exact
 *                    server-computed amount due (the total, minus what a gift card paid).
 *   applyCheckout  → the ONLY way money is recorded and an order becomes paid. Fed by verified
 *                    webhooks, by authenticated status checks (return page, recovery job) and by
 *                    the development simulator. Idempotent per provider payment id.
 * The browser coming back from the payment page proves nothing on its own.
 */

/** Providers require a hosted page to stay open at least 30 minutes; one extra for clock skew. */
const CHECKOUT_LIFETIME_MS = 31 * 60_000;
/** Keep the order (and its pickup slot) held a little past the page's expiry for late webhooks. */
const HOLD_GRACE_MS = 5 * 60_000;
/** Don't send a customer to a page that is about to expire. */
const REUSE_MARGIN_MS = 2 * 60_000;

const system: OrderActor = { kind: "system" };

function appOrigin(): string {
  return new URL(env().BETTER_AUTH_URL).origin;
}

function describe(order: typeof orders.$inferSelect): string {
  const fmt = new Intl.NumberFormat(order.locale, {
    style: "currency",
    currency: "CAD",
  });
  const fr = order.locale !== "en-CA";
  const parts: Array<[string, number]> = [
    [fr ? "Sous-total" : "Subtotal", order.subtotalCents],
    [fr ? "Rabais" : "Discounts", -(order.discountCents + order.rewardDiscountCents)],
    [fr ? "Livraison" : "Delivery", order.deliveryFeeCents],
    [fr ? "TPS" : "GST", order.gstCents],
    [fr ? "TVQ" : "QST", order.qstCents],
    [fr ? "Pourboire" : "Tip", order.tipCents],
    [fr ? "Carte-cadeau" : "Gift card", -order.giftCardCents],
  ];
  return parts
    .filter(([label, cents]) => cents !== 0 || label === "TPS" || label === "GST")
    .map(([label, cents]) => `${label} ${fmt.format(cents / 100)}`)
    .join(" · ");
}

/** The provider customer for a signed-in customer (created once; enables saved cards). */
async function providerCustomerFor(
  db: Database,
  provider: PaymentProvider,
  userId: string,
): Promise<{ customerId: string | null; email: string | null }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { customerId: null, email: null };
  const existing = await db.query.paymentCustomers.findFirst({
    where: and(eq(paymentCustomers.userId, userId), eq(paymentCustomers.provider, provider.name)),
  });
  if (existing) return { customerId: existing.providerCustomerId, email: user.email };
  try {
    const customerId = await provider.createCustomer({ userId, email: user.email });
    await db
      .insert(paymentCustomers)
      .values({ userId, provider: provider.name, providerCustomerId: customerId })
      .onConflictDoNothing();
    return { customerId, email: user.email };
  } catch (error) {
    // Saved cards are a convenience: pay without them rather than block the order.
    logger().warn({ err: error }, "could not create provider customer");
    return { customerId: null, email: user.email };
  }
}

export interface StartedCheckout {
  attemptId: string;
  url: string;
  reused: boolean;
}

/**
 * Opens (or reuses) the hosted payment page for an order awaiting payment. Runs under the order
 * lock: two clicks at once still produce one page. The provider call uses the attempt id as its
 * idempotency key.
 */
export async function openCheckout(
  db: Database,
  provider: PaymentProvider,
  orderId: string,
  options: { locale: "fr" | "en"; guestToken: string | null; userId: string | null; now?: Date },
): Promise<StartedCheckout> {
  const now = options.now ?? new Date();
  const customer =
    options.userId && provider.name !== "fake"
      ? await providerCustomerFor(db, provider, options.userId)
      : { customerId: null, email: null };
  const staleSessions: Array<{ provider: PaymentProvider; sessionId: string }> = [];

  const result = await db.transaction(async (tx) => {
    await expireStaleOrders(tx, now);
    const order = required(await lockOrder(tx, orderId), "order");
    if (order.status === "expired") throw unprocessable("order_expired");
    if (order.status !== "awaiting_payment") throw unprocessable("not_awaiting_payment");

    const live = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.orderId, order.id),
          inArray(paymentAttempts.status, [...LIVE_ATTEMPT_STATUSES]),
        ),
      )
      .for("update");
    for (const attempt of live) {
      if (attempt.status === "processing") throw unprocessable("payment_processing");
      const usable =
        attempt.provider === provider.name &&
        attempt.checkoutUrl &&
        attempt.amountCents === amountDueCents(order) &&
        attempt.expiresAt.getTime() - now.getTime() > REUSE_MARGIN_MS;
      if (usable && attempt.checkoutUrl)
        return { attemptId: attempt.id, url: attempt.checkoutUrl, reused: true };
      // About to expire: close it so it can't be paid alongside the new one.
      await tx
        .update(paymentAttempts)
        .set({ status: "expired" })
        .where(eq(paymentAttempts.id, attempt.id));
      staleSessions.push({
        provider: paymentProvider(attempt.provider),
        sessionId: attempt.providerSessionId,
      });
    }

    const attemptId = randomUUID();
    const token = options.guestToken ? `&token=${encodeURIComponent(options.guestToken)}` : "";
    const base = `${appOrigin()}/${options.locale}`;
    const created = await provider.createCheckout({
      attemptId,
      orderId: order.id,
      orderNumber: order.number,
      amountCents: amountDueCents(order),
      description: describe(order),
      locale: options.locale,
      successUrl: `${base}/checkout/return/${order.id}?session_id={CHECKOUT_SESSION_ID}${token}`,
      cancelUrl: `${base}/checkout/pay/${order.id}?cancelled=1${token}`,
      expiresAt: new Date(now.getTime() + CHECKOUT_LIFETIME_MS),
      customerEmail: customer.email ?? order.guestEmail,
      providerCustomerId: customer.customerId,
    });
    await tx.insert(paymentAttempts).values({
      id: attemptId,
      orderId: order.id,
      provider: provider.name,
      providerSessionId: created.sessionId,
      status: "open",
      amountCents: amountDueCents(order),
      checkoutUrl: created.url,
      expiresAt: created.expiresAt,
      createdAt: now,
    });
    // Hold the order (and its pickup slot) while the payment page can still be paid.
    const holdUntil = new Date(created.expiresAt.getTime() + HOLD_GRACE_MS);
    if (!order.expiresAt || order.expiresAt < holdUntil)
      await tx.update(orders).set({ expiresAt: holdUntil }).where(eq(orders.id, order.id));
    await recordOrderEvent(tx, order.id, "checkout_started", system, {
      provider: provider.name,
      attemptId,
    });
    return { attemptId, url: created.url, reused: false };
  });

  for (const stale of staleSessions) await expireQuietly(stale.provider, stale.sessionId);
  return result;
}

async function expireQuietly(provider: PaymentProvider, sessionId: string): Promise<void> {
  try {
    await provider.expireCheckout(sessionId);
  } catch (error) {
    // Already completed/expired, or unreachable: a payment on it would be refunded as duplicate.
    logger().info({ err: error, sessionId }, "could not expire checkout session");
  }
}

/** POST /orders/:id/checkout — for the order's owner or a guest holding its tracking token. */
export async function startCheckout(
  db: Database,
  actor: Actor | null,
  orderId: string,
  guestToken: string | null,
  locale: "fr" | "en",
  now = new Date(),
): Promise<StartedCheckout> {
  const provider = checkoutProvider();
  if (!provider) throw unprocessable("payments_unavailable");
  const access = await resolveOrderAccess(db, actor, orderId, guestToken);
  if (access.via === "staff") throw notFound("Order");
  return openCheckout(db, provider, orderId, {
    locale,
    guestToken: access.via === "guest_token" ? (guestToken ?? null) : null,
    userId: access.order.userId,
    now,
  });
}

const RECONCILIATION_REASONS: Record<PaymentReconciliation, string> = {
  late: "Automatic refund: payment received after the order expired or was cancelled",
  duplicate: "Automatic refund: the order was already paid",
  amount_mismatch: "Automatic refund: the amount paid didn't match the order total",
};

export interface AppliedCheckout {
  outcome: ReturnType<typeof checkoutOutcome> | "unknown_session" | "duplicate";
  orderStatus: OrderStatus | null;
  refundIds: string[];
}

/** Applies a provider snapshot inside the caller's transaction. */
export async function applyCheckoutInTx(
  tx: Tx,
  providerName: PaymentProvider["name"],
  snapshot: CheckoutSnapshot,
  now: Date,
): Promise<AppliedCheckout> {
  const [found] = await tx
    .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, providerName),
        eq(paymentAttempts.providerSessionId, snapshot.sessionId),
      ),
    );
  if (!found) return { outcome: "unknown_session", orderStatus: null, refundIds: [] };

  // Lock order, then attempt — the same order as everywhere else.
  const order = required(await lockOrder(tx, found.orderId), "order");
  const [locked] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, found.id))
    .for("update");
  const attempt = required(locked, "payment attempt");
  const outcome = checkoutOutcome(snapshot);
  const setAttempt = (status: typeof attempt.status, lastError: string | null = null) =>
    tx.update(paymentAttempts).set({ status, lastError }).where(eq(paymentAttempts.id, attempt.id));
  const live = attempt.status === "open" || attempt.status === "processing";

  switch (outcome) {
    case "open":
      return { outcome, orderStatus: order.status, refundIds: [] };

    case "expired":
      if (live) await setAttempt("expired");
      return { outcome, orderStatus: order.status, refundIds: [] };

    case "processing":
      if (attempt.status === "open") {
        await setAttempt("processing");
        // An asynchronous payment is settling: keep holding the order until it resolves.
        if (order.status === "awaiting_payment")
          await tx.update(orders).set({ expiresAt: null }).where(eq(orders.id, order.id));
        await recordOrderEvent(tx, order.id, "payment_processing", system, {
          attemptId: attempt.id,
        });
      }
      return { outcome, orderStatus: order.status, refundIds: [] };

    case "failed": {
      if (live) {
        await setAttempt("failed", "payment_failed");
        await recordOrderEvent(tx, order.id, "payment_failed", system, {
          attemptId: attempt.id,
        });
        if (order.status === "awaiting_payment") {
          // Give the customer the usual window to try again.
          const config = await loadStoreConfig(tx);
          await tx
            .update(orders)
            .set({ expiresAt: new Date(now.getTime() + config.settings.unpaidTtlMinutes * 60_000) })
            .where(eq(orders.id, order.id));
        }
      }
      return { outcome, orderStatus: order.status, refundIds: [] };
    }

    case "paid": {
      if (!snapshot.paymentId) throw new Error("Paid checkout without a payment reference");
      const [already] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.provider, providerName),
            eq(payments.providerPaymentId, snapshot.paymentId),
          ),
        );
      if (already) {
        if (live) await setAttempt("succeeded");
        return { outcome: "duplicate", orderStatus: order.status, refundIds: [] };
      }
      if (snapshot.currency?.toUpperCase() !== "CAD" || snapshot.amountCents === null) {
        // Can't be recorded as a CAD payment: flag for manual handling, never apply it.
        await setAttempt("failed", "currency_mismatch");
        logger().error({ orderId: order.id, sessionId: snapshot.sessionId }, "non-CAD payment");
        return { outcome: "failed", orderStatus: order.status, refundIds: [] };
      }

      const primary = await primaryPayment(tx, order.id);
      const decision = classifyIncomingPayment({
        orderAwaitingPayment: order.status === "awaiting_payment",
        orderAlreadyPaid: Boolean(primary),
        amountCents:
          snapshot.orderId && snapshot.orderId !== order.id ? null : snapshot.amountCents,
        currency: snapshot.currency,
        expectedCents: attempt.amountCents === amountDueCents(order) ? amountDueCents(order) : -1,
      });
      const reconciliation = decision.action === "refund" ? decision.reconciliation : null;
      const [payment] = await tx
        .insert(payments)
        .values({
          orderId: order.id,
          attemptId: attempt.id,
          provider: providerName,
          providerPaymentId: snapshot.paymentId,
          status: "succeeded",
          amountCents: snapshot.amountCents,
          reconciliation,
          cardBrand: snapshot.card?.brand ?? null,
          cardLast4: snapshot.card?.last4 ?? null,
          succeededAt: now,
        })
        .returning();
      await setAttempt("succeeded");
      await recordOrderEvent(tx, order.id, "payment_recorded", system, {
        provider: providerName,
        amountCents: snapshot.amountCents,
        ...(reconciliation ? { reconciliation } : {}),
      });

      if (decision.action === "apply") {
        let updated = await applyTransition(tx, order, "paid", system, { now });
        const config = await loadStoreConfig(tx);
        if (config.settings.autoAccept)
          updated = await applyTransition(tx, updated, "accepted", system, { now });
        return { outcome, orderStatus: updated.status, refundIds: [] };
      }

      // Late, duplicate or wrong-amount money: give it back in full, automatically.
      const refundId = await requestRefund(tx, {
        payment: required(payment, "payment"),
        orderStatus: order.status,
        amountCents: snapshot.amountCents,
        reason: RECONCILIATION_REASONS[decision.reconciliation],
        source: "system",
        actor: system,
        now,
      });
      return { outcome, orderStatus: order.status, refundIds: [refundId] };
    }
  }
}

/** Applies a snapshot in its own transaction, then submits any automatic refunds. */
export async function applyCheckout(
  db: Database,
  providerName: PaymentProvider["name"],
  snapshot: CheckoutSnapshot,
  now = new Date(),
): Promise<AppliedCheckout> {
  const applied = await db.transaction((tx) => applyCheckoutInTx(tx, providerName, snapshot, now));
  await submitRefunds(db, applied.refundIds, now);
  return applied;
}

/** A declined card on the hosted page. The page stays open, so the customer can try again. */
export async function recordPaymentFailure(
  tx: Tx,
  input: { orderId: string | null; providerPaymentId: string; message: string | null },
): Promise<void> {
  if (!input.orderId) return;
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order) return;
  // The decline message is the provider's generic text (e.g. "Your card was declined.").
  await recordOrderEvent(tx, order.id, "payment_failed", system, {
    providerPaymentId: input.providerPaymentId,
    message: input.message?.slice(0, 200) ?? null,
  });
}

export interface PaymentView {
  state: CustomerPaymentState;
  orderStatus: OrderStatus;
}

/** Current payment state of an order as the customer should see it. */
export async function paymentView(db: Database | Tx, orderId: string): Promise<PaymentView> {
  const [order, attempt, paymentRows] = await Promise.all([
    db.query.orders.findFirst({ where: eq(orders.id, orderId) }),
    db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.orderId, orderId),
      orderBy: desc(paymentAttempts.createdAt),
    }),
    db.select().from(payments).where(eq(payments.orderId, orderId)),
  ]);
  const payment = paymentRows.find((p) => p.reconciliation === null) ?? null;
  return {
    state: customerPaymentState({ payment, latestAttempt: attempt ?? null }),
    orderStatus: required(order, "order").status,
  };
}

/**
 * Return page / "check again": asks the provider (authenticated) about the order's live attempt
 * and applies the answer. Covers a webhook that is late or never arrives.
 */
export async function syncCheckout(
  db: Database,
  actor: Actor | null,
  orderId: string,
  guestToken: string | null,
  now = new Date(),
): Promise<PaymentView> {
  const access = await resolveOrderAccess(db, actor, orderId, guestToken);
  if (access.via === "staff") throw notFound("Order");
  await reconcileLiveAttempt(db, orderId, now);
  return paymentView(db, orderId);
}

/** Status check of the order's open/processing attempt with its provider. */
export async function reconcileLiveAttempt(
  db: Database,
  orderId: string,
  now = new Date(),
): Promise<void> {
  const attempt = await db.query.paymentAttempts.findFirst({
    where: and(
      eq(paymentAttempts.orderId, orderId),
      inArray(paymentAttempts.status, [...LIVE_ATTEMPT_STATUSES]),
    ),
  });
  if (!attempt || attempt.provider === "fake") return;
  const snapshot = await paymentProvider(attempt.provider).getCheckout(attempt.providerSessionId);
  await applyCheckout(db, attempt.provider, snapshot, now);
}

/**
 * DEVELOPMENT SIMULATOR (PAYMENT_PROVIDER=fake only): plays the provider's part. "approve" yields
 * the same snapshot a paid Stripe Checkout would; "decline" records a declined card.
 */
export async function simulateFakePayment(
  db: Database,
  orderId: string,
  outcome: "approve" | "decline",
  options: { locale: "fr" | "en"; guestToken: string | null; userId: string | null; now?: Date },
): Promise<PaymentView> {
  const now = options.now ?? new Date();
  const provider = paymentProvider("fake");
  const { attemptId } = await openCheckout(db, provider, orderId, { ...options, now });
  const attempt = required(
    await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) }),
    "payment attempt",
  );
  if (outcome === "decline") {
    await db.transaction((tx) =>
      recordPaymentFailure(tx, {
        orderId,
        providerPaymentId: `fake_pi_${attempt.id}`,
        message: "Simulated decline",
      }),
    );
  } else {
    await applyCheckout(
      db,
      "fake",
      {
        sessionId: attempt.providerSessionId,
        status: "complete",
        payment: "paid",
        paymentId: `fake_pi_${attempt.id}`,
        amountCents: attempt.amountCents,
        currency: "cad",
        orderId,
        card: { brand: "visa", last4: "4242" },
      },
      now,
    );
  }
  return paymentView(db, orderId);
}

/**
 * Closes the order's open payment pages (after a cancellation), so they can't be paid. If one is
 * paid anyway in the meantime, that money arrives as a late payment and is refunded.
 */
export async function closeOpenCheckouts(db: Database, orderId: string): Promise<void> {
  const open = await db
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, "open")));
  for (const attempt of open) {
    if (attempt.provider !== "fake")
      await expireQuietly(paymentProvider(attempt.provider), attempt.providerSessionId);
    await db
      .update(paymentAttempts)
      .set({ status: "cancelled", lastError: "order_cancelled" })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "open")));
  }
}
