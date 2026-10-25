import {
  and,
  asc,
  auditEvents,
  carts,
  customerProfiles,
  eq,
  favorites,
  inArray,
  loyaltyAccounts,
  loyaltyInStoreVisits,
  loyaltyTransactions,
  notificationPreferences,
  orderItems,
  orders,
  orderStatusEvents,
  payments,
  privacyRequests,
  pushSubscriptions,
  refunds,
  rewards,
  sessions,
  sql,
  users,
  type Database,
} from "@ssc/db";
import { authorize, type Actor } from "../../authz";
import { notFound } from "../../errors";
import { recordSelfServiceRequest } from "./requests";

/*
 * A copy of everything the café holds about a customer (Law 25 right of access and portability),
 * as one JSON document. Orders placed as a guest with the account's email address are included:
 * the address was verified at sign-in, so they are the same person's.
 *
 * Not included: internal staff notes on orders, other people's data, and secrets (session tokens,
 * sign-in codes). Payment cards are held by Stripe; only the brand and last 4 digits are here.
 */

export const EXPORT_FORMAT = "san-sebastian-cafe/personal-data@1";

/** Orders that belong to this person: placed from the account, or as a guest with its email. */
export async function ownOrderIds(db: Database, userId: string, email: string): Promise<string[]> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      sql`${orders.userId} = ${userId} or (${orders.userId} is null and lower(${orders.guestEmail}) = lower(${email}))`,
    );
  return rows.map((r) => r.id);
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function exportPersonalData(db: Database, actor: Actor | null, now = new Date()) {
  authorize(actor, "profile:read_own");
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("Account");
  const orderIds = await ownOrderIds(db, user.id, user.email);
  const byOrders = <T>(run: () => Promise<T[]>) =>
    orderIds.length === 0 ? Promise.resolve([] as T[]) : run();

  const [
    [profile],
    preferences,
    sessionRows,
    orderRows,
    itemRows,
    statusRows,
    paymentRows,
    refundRows,
    [account],
    favoriteRows,
    [cart],
    requestRows,
    consentRows,
    deviceRows,
  ] = await Promise.all([
    db.select().from(customerProfiles).where(eq(customerProfiles.userId, user.id)),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, user.id)),
    db.select().from(sessions).where(eq(sessions.userId, user.id)).orderBy(asc(sessions.createdAt)),
    byOrders(() =>
      db.select().from(orders).where(inArray(orders.id, orderIds)).orderBy(asc(orders.placedAt)),
    ),
    byOrders(() => db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds))),
    byOrders(() =>
      db
        .select()
        .from(orderStatusEvents)
        .where(inArray(orderStatusEvents.orderId, orderIds))
        .orderBy(asc(orderStatusEvents.createdAt)),
    ),
    byOrders(() => db.select().from(payments).where(inArray(payments.orderId, orderIds))),
    byOrders(() => db.select().from(refunds).where(inArray(refunds.orderId, orderIds))),
    db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, user.id)),
    db.select().from(favorites).where(eq(favorites.userId, user.id)),
    db.select().from(carts).where(eq(carts.userId, user.id)),
    db.select().from(privacyRequests).where(eq(privacyRequests.subjectUserId, user.id)),
    db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.actorUserId, user.id), sql`${auditEvents.action} like ${"consent.%"}`),
      )
      .orderBy(asc(auditEvents.createdAt)),
    db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id)),
  ]);
  const [ledger, rewardRows, visits] = account
    ? await Promise.all([
        db
          .select()
          .from(loyaltyTransactions)
          .where(eq(loyaltyTransactions.accountId, account.id))
          .orderBy(asc(loyaltyTransactions.seq)),
        db.select().from(rewards).where(eq(rewards.accountId, account.id)),
        db
          .select()
          .from(loyaltyInStoreVisits)
          .where(eq(loyaltyInStoreVisits.accountId, account.id)),
      ])
    : [[], [], []];
  const numberOf = new Map(orderRows.map((o) => [o.id, o.number]));

  const document = {
    format: EXPORT_FORMAT,
    generatedAt: now.toISOString(),
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      createdAt: iso(user.createdAt),
    },
    profile: profile
      ? {
          preferredLocale: profile.preferredLocale,
          phone: profile.phone,
          onboardedAt: iso(profile.onboardedAt),
        }
      : null,
    communications: preferences.map((p) => ({
      channel: p.channel,
      topic: p.topic,
      enabled: p.enabled,
      consentedAt: iso(p.consentedAt),
    })),
    consentHistory: consentRows.map((c) => ({ action: c.action, at: iso(c.createdAt) })),
    signIns: sessionRows.map((s) => ({
      startedAt: iso(s.createdAt),
      expiresAt: iso(s.expiresAt),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    })),
    notificationDevices: deviceRows.map((d) => ({
      browser: d.userAgent,
      addedAt: iso(d.createdAt),
      lastNotifiedAt: iso(d.lastSuccessAt),
    })),
    orders: orderRows.map((o) => ({
      number: o.number,
      placedAs: o.userId ? "account" : "guest",
      status: o.status,
      placedAt: iso(o.placedAt),
      paidAt: iso(o.paidAt),
      scheduledFor: iso(o.scheduledFor),
      fulfilment: o.fulfilment,
      contact: o.userId ? null : { name: o.guestName, email: o.guestEmail, phone: o.guestPhone },
      deliveryAddress: o.deliveryAddress,
      notes: o.notes,
      cancellationReason: o.cancellationReason,
      amountsCents: {
        subtotal: o.subtotalCents,
        discount: o.discountCents,
        freeDrink: o.rewardDiscountCents,
        deliveryFee: o.deliveryFeeCents,
        gst: o.gstCents,
        qst: o.qstCents,
        tip: o.tipCents,
        total: o.totalCents,
      },
      items: itemRows
        .filter((i) => i.orderId === o.id)
        .map((i) => ({
          product: { fr: i.productNameFr, en: i.productNameEn },
          size: { fr: i.variantNameFr, en: i.variantNameEn },
          options: i.modifiers.map((m) => ({ fr: m.nameFr, en: m.nameEn })),
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          notes: i.notes,
        })),
      statusHistory: statusRows
        .filter((s) => s.orderId === o.id)
        .map((s) => ({ status: s.toStatus, at: iso(s.createdAt), reason: s.reason })),
    })),
    payments: paymentRows.map((p) => ({
      order: numberOf.get(p.orderId) ?? null,
      provider: p.provider,
      status: p.status,
      amountCents: p.amountCents,
      refundedCents: p.refundedCents,
      card: p.cardBrand ? { brand: p.cardBrand, last4: p.cardLast4 } : null,
      paidAt: iso(p.succeededAt),
    })),
    refunds: refundRows.map((r) => ({
      order: numberOf.get(r.orderId) ?? null,
      amountCents: r.amountCents,
      status: r.status,
      reason: r.reason,
      requestedAt: iso(r.createdAt),
      settledAt: iso(r.settledAt),
    })),
    loyalty: account
      ? {
          stampBalance: account.stampBalance,
          stampsOwed: account.stampDebt,
          lifetimeStamps: account.lifetimeStamps,
          history: ledger.map((t) => ({
            kind: t.kind,
            stamps: t.stamps,
            balanceAfter: t.balanceAfter,
            reason: t.reason,
            details: t.details,
            at: iso(t.createdAt),
          })),
          rewards: rewardRows.map((r) => ({
            status: r.status,
            issuedAt: iso(r.issuedAt),
            changedAt: iso(r.statusChangedAt),
          })),
          counterVisits: visits.map((v) => ({
            receipt: v.receiptReference,
            items: v.items.map((i) => ({ fr: i.nameFr, en: i.nameEn, quantity: i.quantity })),
            stampsEarned: v.stampsEarned,
            at: iso(v.createdAt),
            voided: v.voidedAt !== null,
          })),
        }
      : null,
    favorites: favoriteRows.map((f) => ({
      productId: f.productId,
      sizeId: f.variantId,
      optionIds: f.optionIds,
      savedAt: iso(f.createdAt),
    })),
    cart: cart ? { lines: cart.lines, updatedAt: iso(cart.updatedAt) } : null,
    privacyRequests: requestRows.map((r) => ({
      kind: r.kind,
      status: r.status,
      receivedAt: iso(r.receivedAt),
      completedAt: iso(r.completedAt),
      outcome: r.outcome,
    })),
  };

  await db.transaction((tx) => recordSelfServiceRequest(tx, actor.userId, "export", now));
  return document;
}
