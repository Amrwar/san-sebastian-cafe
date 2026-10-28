import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  orders,
  payments,
  refunds,
  sql,
  type Database,
} from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError } from "../../errors";
import { REPORT_TIME_ZONE } from "./range";
import { getSalesReport, parseRange, refundsInPeriod, type ReportPeriod } from "./sales";

/*
 * CSV exports for the accountant: UTF-8 with a byte-order mark (so spreadsheets read accents
 * correctly), comma-separated, amounts in dollars with a decimal point, dates and times at the
 * café. Exports never include customer names or contact details. Each export is audited.
 */

export const EXPORT_KINDS = ["days", "orders", "refunds", "products"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const exportInput = z.object({
  kind: z.enum(EXPORT_KINDS),
  locale: z.enum(["fr", "en"]).default("fr"),
  from: z.string(),
  to: z.string(),
  includeDemo: z.unknown().optional(),
});

type Lang = "fr" | "en";
const HEADERS: Record<ExportKind, Record<Lang, string[]>> = {
  days: {
    fr: [
      "Date",
      "Commandes",
      "Ventes (biens)",
      "TPS",
      "TVQ",
      "Pourboires",
      "Total des ventes",
      "Remboursements",
      "Net",
    ],
    en: ["Date", "Orders", "Sales (goods)", "GST", "QST", "Tips", "Sales total", "Refunds", "Net"],
  },
  orders: {
    fr: [
      "Commande",
      "Payée le",
      "Statut",
      "Articles",
      "Rabais",
      "Boisson offerte",
      "Livraison",
      "Biens",
      "TPS",
      "TVQ",
      "Pourboire",
      "Total",
      "Remboursé à ce jour",
      "Paiement",
    ],
    en: [
      "Order",
      "Paid at",
      "Status",
      "Items",
      "Discount",
      "Free drink",
      "Delivery",
      "Goods",
      "GST",
      "QST",
      "Tip",
      "Total",
      "Refunded to date",
      "Payment",
    ],
  },
  refunds: {
    fr: ["Réglé le", "Commande", "Montant", "Biens", "TPS", "TVQ", "Pourboire", "Origine", "Motif"],
    en: ["Settled at", "Order", "Amount", "Goods", "GST", "QST", "Tip", "Source", "Reason"],
  },
  products: {
    fr: ["Produit", "Catégorie", "Quantité", "Dont offertes", "Ventes avant remboursements"],
    en: ["Product", "Category", "Quantity", "Of which free", "Sales before refunds"],
  },
};

const FILE_NAMES: Record<ExportKind, Record<Lang, string>> = {
  days: { fr: "ventes-par-jour", en: "sales-by-day" },
  orders: { fr: "commandes", en: "orders" },
  refunds: { fr: "remboursements", en: "refunds" },
  products: { fr: "ventes-par-produit", en: "sales-by-product" },
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** One CSV field. Text a spreadsheet would run as a formula is prefixed with an apostrophe. */
export function csvField(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Byte-order mark: tells spreadsheets the file is UTF-8, so accents display correctly. */
const BOM = "\uFEFF";

export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  return `${BOM}${[header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}

const localDateTime = (col: unknown) =>
  sql<string>`to_char(${col} at time zone ${REPORT_TIME_ZONE}, 'YYYY-MM-DD HH24:MI')`;

async function orderRows(db: Database, range: ReportPeriod) {
  const start = sql`(${range.from}::date)::timestamp at time zone ${REPORT_TIME_ZONE}`;
  const end = sql`(${range.to}::date + 1)::timestamp at time zone ${REPORT_TIME_ZONE}`;
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      paidAt: localDateTime(orders.paidAt),
      status: orders.status,
      subtotalCents: orders.subtotalCents,
      discountCents: orders.discountCents,
      rewardDiscountCents: orders.rewardDiscountCents,
      deliveryFeeCents: orders.deliveryFeeCents,
      goodsCents: sql<number>`(${orders.subtotalCents} - ${orders.discountCents} - ${orders.rewardDiscountCents} + ${orders.deliveryFeeCents})::int`,
      gstCents: orders.gstCents,
      qstCents: orders.qstCents,
      tipCents: orders.tipCents,
      totalCents: orders.totalCents,
    })
    .from(orders)
    .where(
      and(
        sql`${orders.paidAt} >= ${start}`,
        sql`${orders.paidAt} < ${end}`,
        range.includeDemo ? undefined : eq(orders.isDemo, false),
      ),
    )
    .orderBy(asc(orders.paidAt));
  if (rows.length === 0) return [];
  // Each order's own payment (not a late or duplicate one) and what has been refunded of it.
  const paid = await db
    .select({
      orderId: payments.orderId,
      provider: payments.provider,
      refundedCents: sql<number>`coalesce(sum(${refunds.amountCents}) filter (where ${refunds.status} = 'succeeded'), 0)::int`,
    })
    .from(payments)
    .leftJoin(refunds, eq(refunds.paymentId, payments.id))
    .where(
      and(
        inArray(
          payments.orderId,
          rows.map((r) => r.id),
        ),
        isNull(payments.reconciliation),
        ne(payments.status, "failed"),
      ),
    )
    .groupBy(payments.orderId, payments.provider);
  const byOrder = new Map(paid.map((p) => [p.orderId, p]));
  return rows.map((r) => ({
    ...r,
    provider: byOrder.get(r.id)?.provider ?? "",
    refundedCents: byOrder.get(r.id)?.refundedCents ?? 0,
  }));
}

/** Builds one CSV export and records it in the audit log. */
export async function exportReportCsv(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<{ fileName: string; csv: string }> {
  authorize(actor, "reports:read");
  const input = exportInput.safeParse(raw);
  if (!input.success) throw fromZodError(input.error);
  const { kind, locale } = input.data;
  const range = parseRange(raw);
  const fr = locale === "fr";

  let rows: Array<Array<string | number>>;
  if (kind === "orders") {
    rows = (await orderRows(db, range)).map((o) => [
      o.number,
      o.paidAt,
      o.status,
      dollars(o.subtotalCents),
      dollars(o.discountCents),
      dollars(o.rewardDiscountCents),
      dollars(o.deliveryFeeCents),
      dollars(o.goodsCents),
      dollars(o.gstCents),
      dollars(o.qstCents),
      dollars(o.tipCents),
      dollars(o.totalCents),
      dollars(o.refundedCents),
      o.provider,
    ]);
  } else if (kind === "refunds") {
    const list = await refundsInPeriod(db, range);
    rows = list.map((r) => [
      r.settledLocal,
      r.orderNumber,
      dollars(r.amountCents),
      dollars(r.goodsCents),
      dollars(r.gstCents),
      dollars(r.qstCents),
      dollars(r.tipCents),
      r.source,
      r.reason,
    ]);
  } else {
    const report = await getSalesReport(db, actor, range);
    rows =
      kind === "days"
        ? report.days.map((d) => [
            d.date,
            d.sales.orders,
            dollars(d.sales.goodsCents),
            dollars(d.sales.gstCents),
            dollars(d.sales.qstCents),
            dollars(d.sales.tipCents),
            dollars(d.sales.totalCents),
            dollars(d.refundsCents),
            dollars(d.sales.totalCents - d.refundsCents),
          ])
        : report.products.map((p) => [
            fr ? p.nameFr : p.nameEn,
            (fr ? p.categoryNameFr : p.categoryNameEn) ?? "",
            p.quantity,
            p.freeUnits,
            dollars(p.salesCents),
          ]);
  }

  await db.transaction((tx) =>
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: "report.exported",
      entityType: "report",
      metadata: {
        kind,
        from: range.from,
        to: range.to,
        includeDemo: range.includeDemo,
        rows: rows.length,
      },
    }),
  );
  return {
    fileName: `${FILE_NAMES[kind][locale]}_${range.from}_${range.to}.csv`,
    csv: toCsv(HEADERS[kind][locale], rows),
  };
}
