import {
  and,
  asc,
  categories,
  eq,
  inArray,
  isNull,
  loyaltyAccounts,
  orderItems,
  orders,
  payments,
  products,
  refunds,
  rewardRedemptions,
  rewards,
  sql,
  type Database,
} from "@ssc/db";
import type { TaxCategory } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";
import { fromZodError } from "../../errors";
import { eachDay, REPORT_TIME_ZONE, reportRangeInput, type ReportRange } from "./range";
import { splitRefunds, type MoneySplit } from "./refund-split";

/*
 * Sales reporting (manager and above), in Canadian dollars and the café's time zone.
 *
 * - A sale counts on the day its payment succeeded (`orders.paid_at`), whatever happened to the
 *   order afterwards. Unpaid, expired and demo orders never count.
 * - A refund counts on the day it settled, as a separate line. Refunds only store an amount, so
 *   their GST, QST and tip shares are pro rata to the order (see refund-split.ts).
 * - Late or duplicate payments (refunded automatically) are neither sales nor refunds; they are
 *   reported apart so the money still adds up.
 * - Product and category figures are sales before refunds, since refunds aren't tied to amounts
 *   per item.
 */

/** A period, and whether demo orders and loyalty cards count (they never do unless asked). */
export type ReportPeriod = ReportRange & { includeDemo: boolean };

export function parseRange(raw: unknown): ReportPeriod {
  const input = (raw ?? {}) as { from?: unknown; to?: unknown; includeDemo?: unknown };
  const result = reportRangeInput.safeParse({ from: input.from, to: input.to });
  if (!result.success) throw fromZodError(result.error);
  return { ...result.data, includeDemo: input.includeDemo === true || input.includeDemo === "1" };
}

/** Rows to leave out unless demo data was asked for. */
const demoFilter = (
  period: ReportPeriod,
  column: typeof orders.isDemo | typeof loyaltyAccounts.isDemo,
) => (period.includeDemo ? undefined : eq(column, false));

/** SQL bounds of a range: [start of `from`, start of the day after `to`) at the café. */
function bounds(range: ReportRange) {
  return {
    start: sql`(${range.from}::date)::timestamp at time zone ${REPORT_TIME_ZONE}`,
    end: sql`(${range.to}::date + 1)::timestamp at time zone ${REPORT_TIME_ZONE}`,
  };
}

const localDay = (col: unknown) =>
  sql<string>`to_char(${col} at time zone ${REPORT_TIME_ZONE}, 'YYYY-MM-DD')`;
const int = (expr: unknown) => sql<number>`coalesce(sum(${expr}), 0)::int`;
/** Goods sold on an order: items after discounts and free drinks, plus any delivery fee. */
const orderGoods = sql`${orders.subtotalCents} - ${orders.discountCents} - ${orders.rewardDiscountCents} + ${orders.deliveryFeeCents}`;
const lineNet = sql`${orderItems.lineTotalCents} - ${orderItems.discountCents} - ${orderItems.rewardDiscountCents}`;

export interface SalesTotals extends MoneySplit {
  orders: number;
  totalCents: number;
}

export interface RefundTotals extends MoneySplit {
  count: number;
  totalCents: number;
}

export interface SalesReport {
  range: ReportPeriod;
  sales: SalesTotals & {
    itemsCents: number;
    discountCents: number;
    rewardDiscountCents: number;
    averageCents: number | null;
  };
  refunds: RefundTotals & {
    bySource: Array<{ source: string; count: number; totalCents: number }>;
  };
  /** Sales minus refunds, per component. */
  net: MoneySplit & { totalCents: number };
  days: Array<{ date: string; sales: SalesTotals; refundsCents: number }>;
  /** Local hour of payment (0–23), all days of the range together. */
  hours: Array<{ hour: number; orders: number; totalCents: number }>;
  products: Array<{
    productId: string;
    categoryId: string | null;
    nameFr: string;
    nameEn: string;
    categoryNameFr: string | null;
    categoryNameEn: string | null;
    quantity: number;
    freeUnits: number;
    salesCents: number;
  }>;
  categories: Array<{
    categoryId: string | null;
    nameFr: string | null;
    nameEn: string | null;
    quantity: number;
    salesCents: number;
  }>;
  taxCategories: Array<{ taxCategory: TaxCategory; salesCents: number }>;
  reconciliation: {
    /** Order payments recorded for this period's sales. */
    paymentsCents: number;
    /** Paid orders whose payment is missing or for another amount. */
    mismatches: Array<{
      orderId: string;
      number: string;
      totalCents: number;
      paidCents: number | null;
    }>;
    /** Late or duplicate payments received in the period, and what was refunded of them. */
    extraPayments: { count: number; receivedCents: number; refundedCents: number };
  };
  loyalty: {
    issued: number;
    redeemed: number;
    redeemedValueCents: number;
    revoked: number;
    /** Free drinks owed right now (not limited to the period). */
    outstanding: number;
    /** Outstanding × the average value of free drinks redeemed so far; null without history. */
    estimatedLiabilityCents: number | null;
    averageRewardCents: number | null;
    /** Stamps customers hold toward their next free drink, right now. */
    stampsInProgress: number;
  };
  /** Demo orders paid in the period, left out of every figure (0 when they are included). */
  demoOrdersExcluded: number;
}

const ZERO: MoneySplit = { goodsCents: 0, gstCents: 0, qstCents: 0, tipCents: 0 };
const addSplit = (a: MoneySplit, b: MoneySplit): MoneySplit => ({
  goodsCents: a.goodsCents + b.goodsCents,
  gstCents: a.gstCents + b.gstCents,
  qstCents: a.qstCents + b.qstCents,
  tipCents: a.tipCents + b.tipCents,
});
const splitTotal = (s: MoneySplit) => s.goodsCents + s.gstCents + s.qstCents + s.tipCents;

export interface ReportRefund extends MoneySplit {
  refundId: string;
  orderId: string;
  orderNumber: string;
  date: string;
  /** Local date and time at the café (YYYY-MM-DD HH:MM). */
  settledLocal: string;
  amountCents: number;
  source: string;
  reason: string;
}

/**
 * Refunds of order payments settled in the period, each split pro rata to its order. The split
 * takes the order's earlier refunds into account, so it is the same whatever period is asked.
 */
export async function refundsInPeriod(db: Database, range: ReportPeriod): Promise<ReportRefund[]> {
  const { start, end } = bounds(range);
  const succeeded = and(
    eq(refunds.status, "succeeded"),
    demoFilter(range, orders.isDemo),
    // Refunds of late/duplicate payments aren't refunds of a sale.
    sql`(${payments.reconciliation} is null)`,
  );
  const inPeriod = await db
    .selectDistinct({ orderId: refunds.orderId })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(succeeded, sql`${refunds.settledAt} >= ${start}`, sql`${refunds.settledAt} < ${end}`),
    );
  if (inPeriod.length === 0) return [];

  const rows = await db
    .select({
      refundId: refunds.id,
      orderId: refunds.orderId,
      orderNumber: orders.number,
      date: localDay(refunds.settledAt),
      settledLocal: sql<string>`to_char(${refunds.settledAt} at time zone ${REPORT_TIME_ZONE}, 'YYYY-MM-DD HH24:MI')`,
      inPeriod: sql<boolean>`${refunds.settledAt} >= ${start} and ${refunds.settledAt} < ${end}`,
      amountCents: refunds.amountCents,
      source: refunds.source,
      reason: refunds.reason,
      goodsCents: sql<number>`(${orderGoods})::int`,
      gstCents: orders.gstCents,
      qstCents: orders.qstCents,
      tipCents: orders.tipCents,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        succeeded,
        inArray(
          refunds.orderId,
          inPeriod.map((r) => r.orderId),
        ),
      ),
    )
    .orderBy(asc(refunds.orderId), asc(refunds.settledAt), asc(refunds.id));

  const byOrder = new Map<string, typeof rows>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  const out: ReportRefund[] = [];
  for (const [orderId, own] of byOrder) {
    const [first] = own;
    if (!first) continue;
    const parts = splitRefunds(
      {
        goodsCents: first.goodsCents,
        gstCents: first.gstCents,
        qstCents: first.qstCents,
        tipCents: first.tipCents,
      },
      own.map((r) => r.amountCents),
    );
    own.forEach((r, i) => {
      const part = parts[i];
      if (!r.inPeriod || !part) return;
      out.push({
        refundId: r.refundId,
        orderId,
        orderNumber: r.orderNumber,
        date: r.date,
        settledLocal: r.settledLocal,
        amountCents: r.amountCents,
        source: r.source,
        reason: r.reason,
        ...part,
      });
    });
  }
  return out.sort((a, b) => a.settledLocal.localeCompare(b.settledLocal));
}

export async function getSalesReport(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<SalesReport> {
  authorize(actor, "reports:read");
  const range = parseRange(raw);
  const { start, end } = bounds(range);
  const paidIn = and(sql`${orders.paidAt} >= ${start}`, sql`${orders.paidAt} < ${end}`);
  const paid = and(paidIn, demoFilter(range, orders.isDemo));

  const salesColumns = {
    orders: sql<number>`count(*)::int`,
    goodsCents: int(orderGoods),
    gstCents: int(orders.gstCents),
    qstCents: int(orders.qstCents),
    tipCents: int(orders.tipCents),
    totalCents: int(orders.totalCents),
  };

  const [
    [totals],
    days,
    hours,
    productRows,
    taxRows,
    refundRows,
    paymentCheck,
    [extra],
    [demo],
    loyalty,
  ] = await Promise.all([
    db
      .select({
        ...salesColumns,
        itemsCents: int(orders.subtotalCents),
        discountCents: int(orders.discountCents),
        rewardDiscountCents: int(orders.rewardDiscountCents),
      })
      .from(orders)
      .where(paid),
    db
      .select({ date: localDay(orders.paidAt), ...salesColumns })
      .from(orders)
      .where(paid)
      .groupBy(sql`1`),
    db
      .select({
        hour: sql<number>`extract(hour from ${orders.paidAt} at time zone ${REPORT_TIME_ZONE})::int`,
        orders: sql<number>`count(*)::int`,
        totalCents: int(orders.totalCents),
      })
      .from(orders)
      .where(paid)
      .groupBy(sql`1`),
    db
      .select({
        productId: orderItems.productId,
        nameFr: sql<string>`min(coalesce(${products.nameFr}, ${orderItems.productNameFr}))`,
        nameEn: sql<string>`min(coalesce(${products.nameEn}, ${orderItems.productNameEn}))`,
        categoryId: products.categoryId,
        categoryNameFr: categories.nameFr,
        categoryNameEn: categories.nameEn,
        quantity: int(orderItems.quantity),
        freeUnits: sql<number>`count(*) filter (where ${orderItems.rewardDiscountCents} > 0)::int`,
        salesCents: int(lineNet),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(paid)
      .groupBy(orderItems.productId, products.categoryId, categories.nameFr, categories.nameEn),
    db
      .select({ taxCategory: orderItems.taxCategory, salesCents: int(lineNet) })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(paid)
      .groupBy(orderItems.taxCategory),
    refundsInPeriod(db, range),
    db
      .select({
        orderId: orders.id,
        number: orders.number,
        totalCents: orders.totalCents,
        paidCents: payments.amountCents,
      })
      .from(orders)
      .leftJoin(
        payments,
        and(
          eq(payments.orderId, orders.id),
          isNull(payments.reconciliation),
          sql`${payments.status} not in ('failed', 'pending', 'requires_action', 'cancelled')`,
        ),
      )
      .where(paid),
    db
      .select({
        count: sql<number>`count(*)::int`,
        receivedCents: int(payments.amountCents),
        refundedCents: int(payments.refundedCents),
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          sql`${payments.reconciliation} is not null`,
          demoFilter(range, orders.isDemo),
          sql`${payments.succeededAt} >= ${start}`,
          sql`${payments.succeededAt} < ${end}`,
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(paidIn, eq(orders.isDemo, true))),
    loyaltyFigures(db, range, now),
  ]);

  const t = totals ?? {
    orders: 0,
    goodsCents: 0,
    gstCents: 0,
    qstCents: 0,
    tipCents: 0,
    totalCents: 0,
    itemsCents: 0,
    discountCents: 0,
    rewardDiscountCents: 0,
  };
  const refundSplit = refundRows.reduce<MoneySplit>((s, r) => addSplit(s, r), ZERO);
  const refundTotal = splitTotal(refundSplit);
  const bySource = new Map<string, { count: number; totalCents: number }>();
  for (const r of refundRows) {
    const s = bySource.get(r.source) ?? { count: 0, totalCents: 0 };
    bySource.set(r.source, { count: s.count + 1, totalCents: s.totalCents + r.amountCents });
  }
  const refundsByDay = new Map<string, number>();
  for (const r of refundRows)
    refundsByDay.set(r.date, (refundsByDay.get(r.date) ?? 0) + r.amountCents);
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const hourMap = new Map(hours.map((h) => [h.hour, h]));

  const categoryMap = new Map<string, SalesReport["categories"][number]>();
  for (const p of productRows) {
    const key = p.categoryId ?? "none";
    const c = categoryMap.get(key) ?? {
      categoryId: p.categoryId,
      nameFr: p.categoryNameFr,
      nameEn: p.categoryNameEn,
      quantity: 0,
      salesCents: 0,
    };
    categoryMap.set(key, {
      ...c,
      quantity: c.quantity + p.quantity,
      salesCents: c.salesCents + p.salesCents,
    });
  }
  const bySales = <T extends { salesCents: number }>(a: T, b: T) => b.salesCents - a.salesCents;

  return {
    range,
    sales: {
      orders: t.orders,
      goodsCents: t.goodsCents,
      gstCents: t.gstCents,
      qstCents: t.qstCents,
      tipCents: t.tipCents,
      totalCents: t.totalCents,
      itemsCents: t.itemsCents,
      discountCents: t.discountCents,
      rewardDiscountCents: t.rewardDiscountCents,
      averageCents: t.orders > 0 ? Math.round(t.totalCents / t.orders) : null,
    },
    refunds: {
      count: refundRows.length,
      totalCents: refundTotal,
      ...refundSplit,
      bySource: [...bySource].map(([source, v]) => ({ source, ...v })),
    },
    net: {
      goodsCents: t.goodsCents - refundSplit.goodsCents,
      gstCents: t.gstCents - refundSplit.gstCents,
      qstCents: t.qstCents - refundSplit.qstCents,
      tipCents: t.tipCents - refundSplit.tipCents,
      totalCents: t.totalCents - refundTotal,
    },
    days: eachDay(range).map((date) => {
      const d = dayMap.get(date);
      return {
        date,
        sales: {
          orders: d?.orders ?? 0,
          goodsCents: d?.goodsCents ?? 0,
          gstCents: d?.gstCents ?? 0,
          qstCents: d?.qstCents ?? 0,
          tipCents: d?.tipCents ?? 0,
          totalCents: d?.totalCents ?? 0,
        },
        refundsCents: refundsByDay.get(date) ?? 0,
      };
    }),
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orders: hourMap.get(hour)?.orders ?? 0,
      totalCents: hourMap.get(hour)?.totalCents ?? 0,
    })),
    products: productRows.sort((a, b) => bySales(a, b) || a.nameFr.localeCompare(b.nameFr)),
    categories: [...categoryMap.values()].sort(bySales),
    taxCategories: taxRows.sort(bySales),
    reconciliation: {
      paymentsCents: paymentCheck.reduce((s, p) => s + (p.paidCents ?? 0), 0),
      mismatches: paymentCheck.filter((p) => p.paidCents !== p.totalCents),
      extraPayments: extra ?? { count: 0, receivedCents: 0, refundedCents: 0 },
    },
    loyalty,
    demoOrdersExcluded: range.includeDemo ? 0 : (demo?.count ?? 0),
  };
}

async function loyaltyFigures(
  db: Database,
  range: ReportPeriod,
  now: Date,
): Promise<SalesReport["loyalty"]> {
  const { start, end } = bounds(range);
  const real = demoFilter(range, loyaltyAccounts.isDemo);
  const changedIn = and(
    sql`${rewards.statusChangedAt} >= ${start}`,
    sql`${rewards.statusChangedAt} < ${end}`,
  );
  const [[figures], [redeemedValue], [average], [stamps]] = await Promise.all([
    db
      .select({
        issued: sql<number>`count(*) filter (where ${rewards.issuedAt} >= ${start} and ${rewards.issuedAt} < ${end})::int`,
        redeemed: sql<number>`count(*) filter (where ${rewards.status} = 'redeemed' and ${changedIn})::int`,
        revoked: sql<number>`count(*) filter (where ${rewards.status} = 'revoked' and ${changedIn})::int`,
        outstanding: sql<number>`count(*) filter (where ${rewards.status} in ('available', 'reserved') and (${rewards.expiresAt} is null or ${rewards.expiresAt} > ${now.toISOString()}::timestamptz))::int`,
      })
      .from(rewards)
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
      .where(real),
    db
      .select({ cents: int(rewardRedemptions.discountCents) })
      .from(rewardRedemptions)
      .innerJoin(rewards, eq(rewards.id, rewardRedemptions.rewardId))
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
      .where(
        and(
          real,
          eq(rewardRedemptions.status, "committed"),
          eq(rewards.status, "redeemed"),
          changedIn,
        ),
      ),
    db
      .select({ cents: sql<number | null>`round(avg(${rewardRedemptions.discountCents}))::int` })
      .from(rewardRedemptions)
      .innerJoin(rewards, eq(rewards.id, rewardRedemptions.rewardId))
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
      .where(and(real, eq(rewardRedemptions.status, "committed"))),
    db
      .select({ stamps: int(loyaltyAccounts.stampBalance) })
      .from(loyaltyAccounts)
      .where(real),
  ]);
  const outstanding = figures?.outstanding ?? 0;
  const averageRewardCents = average?.cents ?? null;
  return {
    issued: figures?.issued ?? 0,
    redeemed: figures?.redeemed ?? 0,
    redeemedValueCents: redeemedValue?.cents ?? 0,
    revoked: figures?.revoked ?? 0,
    outstanding,
    estimatedLiabilityCents: averageRewardCents === null ? null : outstanding * averageRewardCents,
    averageRewardCents,
    stampsInProgress: stamps?.stamps ?? 0,
  };
}
