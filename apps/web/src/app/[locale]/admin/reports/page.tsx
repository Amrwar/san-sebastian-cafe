import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  Alert,
  Button,
  buttonClasses,
  CheckboxField,
  cn,
  Container,
  PageHeader,
  Surface,
  TextField,
} from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { BarChart } from "@/components/BarChart";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { EXPORT_KINDS } from "@/server/modules/reports/export";
import {
  cafeToday,
  presetRange,
  REPORT_PRESETS,
  type ReportRange,
} from "@/server/modules/reports/range";
import { getSalesReport, type SalesReport } from "@/server/modules/reports/sales";
import { requirePermissionForPage } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/reports">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminReports" });
  return { title: t("title"), robots: { index: false } };
}

const text = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Sales, taxes, tips, refunds and loyalty for a period, with CSV exports (manager and above). */
export default async function AdminReportsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/reports">) {
  const { locale } = await params;
  const sp = await searchParams;
  const access = await requirePermissionForPage(locale, `/${locale}/admin/reports`, "reports:read");
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;

  const today = cafeToday();
  const fallback = presetRange("last7", today);
  const includeDemo = sp.demo === "1";
  const asked = { from: text(sp.from) ?? fallback.from, to: text(sp.to) ?? fallback.to };

  const [t, tTax, format] = await Promise.all([
    getTranslations("AdminReports"),
    getTranslations("AdminProduct.taxCategories"),
    getFormatter(),
  ]);
  let invalid = false;
  let report: SalesReport;
  try {
    report = await getSalesReport(db(), user, { ...asked, includeDemo });
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== "validation_failed") throw e;
    invalid = true;
    report = await getSalesReport(db(), user, { ...fallback, includeDemo });
  }
  const { range } = report;

  const $ = (cents: number) => money(cents, locale);
  /** A café date (YYYY-MM-DD) for display; noon UTC keeps it on the same calendar day. */
  const day = (date: string, style: "short" | "long" = "short") =>
    format.dateTime(new Date(`${date}T12:00:00Z`), {
      timeZone: "UTC",
      ...(style === "short"
        ? { day: "numeric", month: "short" }
        : { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    });
  const query = (r: ReportRange, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ from: r.from, to: r.to, ...extra });
    if (includeDemo) q.set("demo", "1");
    return q.toString();
  };
  const isPreset = (r: ReportRange) => r.from === range.from && r.to === range.to;

  const { sales, refunds, net, reconciliation: rec, loyalty, giftCards } = report;
  const maxDay = Math.max(0, ...report.days.map((d) => d.sales.totalCents));
  const maxHour = Math.max(0, ...report.hours.map((h) => h.orders));
  // Daytime hours (7 h–18 h), widened to any hour that had sales.
  const busy = report.hours.filter((h) => h.orders > 0).map((h) => h.hour);
  const firstHour = Math.min(7, ...busy);
  const lastHour = Math.max(18, ...busy);
  const hours = report.hours.filter((h) => h.hour >= firstHour && h.hour <= lastHour);

  return (
    <Container className="max-w-6xl pb-10">
      <PageHeader title={t("title")}>
        <p className="max-w-2xl text-espresso-muted">{t("intro")}</p>
      </PageHeader>
      <AdminNav current="reports" role={user.role} />

      {/* Period */}
      <Surface className="mb-6 flex flex-col gap-4">
        <nav aria-label={t("presets.label")}>
          <ul className="flex flex-wrap gap-2">
            {REPORT_PRESETS.map((p) => {
              const r = presetRange(p, today);
              return (
                <li key={p}>
                  <Link
                    href={`/admin/reports?${query(r)}`}
                    aria-current={isPreset(r) ? "true" : undefined}
                    className={cn(
                      "inline-flex min-h-11 items-center rounded-pill border px-4 text-[0.95rem]",
                      isPreset(r)
                        ? "border-burgundy bg-burgundy text-ivory"
                        : "border-line-strong bg-ivory-raised text-espresso hover:border-espresso-muted",
                    )}
                  >
                    {t(`presets.${p}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <form method="get" className="flex flex-wrap items-end gap-4">
          <TextField
            label={t("from")}
            type="date"
            name="from"
            defaultValue={range.from}
            className="w-44"
          />
          <TextField
            label={t("to")}
            type="date"
            name="to"
            defaultValue={range.to}
            className="w-44"
          />
          <CheckboxField
            label={t("includeDemo")}
            name="demo"
            value="1"
            defaultChecked={includeDemo}
            className="mb-2.5"
          />
          <Button type="submit" variant="secondary">
            {t("show")}
          </Button>
        </form>
        {invalid ? <Alert tone="danger">{t("invalidPeriod")}</Alert> : null}
        {includeDemo ? (
          <Alert tone="warning">{t("demoIncluded")}</Alert>
        ) : report.demoOrdersExcluded > 0 ? (
          <p className="text-sm text-espresso-muted">
            {t("demoExcluded", { count: report.demoOrdersExcluded })}
          </p>
        ) : null}
      </Surface>

      <p className="mb-4 font-semibold text-espresso">
        {t("periodShown", { from: day(range.from, "long"), to: day(range.to, "long") })}
      </p>

      {/* Headline figures */}
      <dl className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t("tiles.sales")} value={$(sales.totalCents)} hero />
        <Tile
          label={t("tiles.net")}
          value={$(net.totalCents)}
          note={t("tiles.refundsNote", { amount: $(refunds.totalCents), count: refunds.count })}
        />
        <Tile label={t("tiles.orders")} value={format.number(sales.orders)} />
        <Tile
          label={t("tiles.average")}
          value={sales.averageCents === null ? "—" : $(sales.averageCents)}
        />
      </dl>

      {/* Payments check */}
      <div className="mb-6 flex flex-col gap-2">
        {rec.mismatches.length === 0 ? (
          <Alert tone="success">
            {rec.giftCardsCents > 0
              ? t("reconciliation.okWithGiftCards", {
                  amount: $(rec.paymentsCents),
                  giftCards: $(rec.giftCardsCents),
                })
              : t("reconciliation.ok", { amount: $(rec.paymentsCents) })}
          </Alert>
        ) : (
          <Alert tone="danger">
            <p>{t("reconciliation.mismatch", { count: rec.mismatches.length })}</p>
            <ul className="mt-1 list-disc ps-5">
              {rec.mismatches.map((m) => (
                <li key={m.orderId}>
                  {m.number} —{" "}
                  {m.paidCents === null
                    ? t("reconciliation.missing", { total: $(m.totalCents) })
                    : t("reconciliation.paid", {
                        total: $(m.totalCents),
                        paid: $(m.paidCents + m.giftCardCents),
                      })}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {rec.extraPayments.count > 0 ? (
          <Alert tone="warning">
            {t("reconciliation.extra", {
              count: rec.extraPayments.count,
              received: $(rec.extraPayments.receivedCents),
              refunded: $(rec.extraPayments.refundedCents),
            })}
          </Alert>
        ) : null}
      </div>

      {/* Taxes and tips */}
      <Section title={t("taxes.title")} hint={t("taxes.hint")}>
        <Table
          head={[
            t("taxes.row"),
            t("taxes.goods"),
            t("taxes.gst"),
            t("taxes.qst"),
            t("taxes.tips"),
            t("taxes.total"),
          ]}
          numeric={[1, 2, 3, 4, 5]}
          rows={[
            [
              t("taxes.sales"),
              sales.goodsCents,
              sales.gstCents,
              sales.qstCents,
              sales.tipCents,
              sales.totalCents,
            ],
            [
              t("taxes.refunds"),
              0 - refunds.goodsCents,
              0 - refunds.gstCents,
              0 - refunds.qstCents,
              0 - refunds.tipCents,
              0 - refunds.totalCents,
            ],
            [
              t("taxes.net"),
              net.goodsCents,
              net.gstCents,
              net.qstCents,
              net.tipCents,
              net.totalCents,
            ],
          ].map(([label, ...amounts]) => [label as string, ...(amounts as number[]).map($)])}
          strongLastRow
        />
        <p className="mt-3 text-sm text-espresso-muted">
          {t("taxes.discounts", {
            promo: $(sales.discountCents),
            reward: $(sales.rewardDiscountCents),
          })}
        </p>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("byDay.title")}>
          <BarChart
            label={t("byDay.chartLabel", { from: day(range.from), to: day(range.to) })}
            maxLabel={$(maxDay)}
            bars={report.days.map((d) => ({
              key: d.date,
              label: day(d.date),
              value: d.sales.totalCents,
              tooltip: t("byDay.tooltip", {
                date: day(d.date),
                sales: $(d.sales.totalCents),
                orders: d.sales.orders,
              }),
            }))}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-semibold text-burgundy">
              {t("byDay.table")}
            </summary>
            <div className="mt-3">
              <Table
                head={[
                  t("byDay.date"),
                  t("byDay.orders"),
                  t("byDay.sales"),
                  t("byDay.refunds"),
                  t("byDay.net"),
                ]}
                numeric={[1, 2, 3, 4]}
                rows={report.days.map((d) => [
                  day(d.date, "long"),
                  format.number(d.sales.orders),
                  $(d.sales.totalCents),
                  $(d.refundsCents),
                  $(d.sales.totalCents - d.refundsCents),
                ])}
              />
            </div>
          </details>
        </Section>

        <Section title={t("byHour.title")} hint={t("byHour.hint")}>
          <BarChart
            label={t("byHour.title")}
            maxLabel={format.number(maxHour)}
            bars={hours.map((h) => ({
              key: String(h.hour),
              label: `${h.hour} h`,
              value: h.orders,
              tooltip: t("byHour.tooltip", {
                hour: h.hour,
                orders: h.orders,
                sales: $(h.totalCents),
              }),
            }))}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-semibold text-burgundy">
              {t("byDay.table")}
            </summary>
            <div className="mt-3">
              <Table
                head={[t("byHour.hour"), t("byHour.orders"), t("byHour.sales")]}
                numeric={[1, 2]}
                rows={hours.map((h) => [`${h.hour} h`, format.number(h.orders), $(h.totalCents)])}
              />
            </div>
          </details>
        </Section>
      </div>

      <Section title={t("byProduct.title")} hint={t("byProduct.hint")}>
        {report.products.length === 0 ? (
          <p className="text-espresso-muted">{t("byProduct.empty")}</p>
        ) : (
          <Table
            head={[
              t("byProduct.product"),
              t("byProduct.category"),
              t("byProduct.quantity"),
              t("byProduct.free"),
              t("byProduct.sales"),
            ]}
            numeric={[2, 3, 4]}
            rows={report.products.map((p) => [
              locale === "fr" ? p.nameFr : p.nameEn,
              (locale === "fr" ? p.categoryNameFr : p.categoryNameEn) ?? t("byProduct.noCategory"),
              format.number(p.quantity),
              format.number(p.freeUnits),
              $(p.salesCents),
            ])}
          />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("byCategory.title")}>
          {report.categories.length === 0 ? (
            <p className="text-espresso-muted">{t("byProduct.empty")}</p>
          ) : (
            <Table
              head={[t("byProduct.category"), t("byProduct.quantity"), t("byProduct.sales")]}
              numeric={[1, 2]}
              rows={report.categories.map((c) => [
                (locale === "fr" ? c.nameFr : c.nameEn) ?? t("byProduct.noCategory"),
                format.number(c.quantity),
                $(c.salesCents),
              ])}
            />
          )}
        </Section>
        <Section title={t("byTax.title")}>
          {report.taxCategories.length === 0 ? (
            <p className="text-espresso-muted">{t("byProduct.empty")}</p>
          ) : (
            <Table
              head={[t("byTax.category"), t("byProduct.sales")]}
              numeric={[1]}
              rows={report.taxCategories.map((c) => [tTax(c.taxCategory), $(c.salesCents)])}
            />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("refunds.title")}>
          {refunds.bySource.length === 0 ? (
            <p className="text-espresso-muted">{t("refunds.empty")}</p>
          ) : (
            <Table
              head={[t("refunds.source"), t("refunds.count"), t("refunds.amount")]}
              numeric={[1, 2]}
              rows={refunds.bySource.map((s) => [
                t.has(`refunds.sources.${s.source}`)
                  ? t(`refunds.sources.${s.source}` as "refunds.sources.staff")
                  : s.source,
                format.number(s.count),
                $(s.totalCents),
              ])}
            />
          )}
        </Section>

        <Section title={t("loyalty.title")}>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Tile label={t("loyalty.issued")} value={format.number(loyalty.issued)} plain />
            <Tile
              label={t("loyalty.redeemed")}
              value={format.number(loyalty.redeemed)}
              note={t("loyalty.redeemedValue", { amount: $(loyalty.redeemedValueCents) })}
              plain
            />
            <Tile label={t("loyalty.revoked")} value={format.number(loyalty.revoked)} plain />
            <Tile
              label={t("loyalty.outstanding")}
              value={format.number(loyalty.outstanding)}
              note={
                loyalty.estimatedLiabilityCents === null || loyalty.averageRewardCents === null
                  ? t("loyalty.noLiability")
                  : `${t("loyalty.liability", { amount: $(loyalty.estimatedLiabilityCents) })} — ${t("loyalty.liabilityHint", { average: $(loyalty.averageRewardCents) })}`
              }
              plain
            />
          </dl>
          <p className="mt-3 text-sm text-espresso-muted">
            {t("loyalty.stamps", { count: format.number(loyalty.stampsInProgress) })}
          </p>
        </Section>

        <Section title={t("giftCards.title")} hint={t("giftCards.hint")}>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Tile
              label={t("giftCards.outstanding")}
              value={$(giftCards.outstandingCents)}
              note={t("giftCards.cards", { count: format.number(giftCards.cardsWithBalance) })}
              plain
            />
            <Tile
              label={t("giftCards.issued")}
              value={$(giftCards.issuedCents)}
              note={
                giftCards.soldOnline.count > 0
                  ? t("giftCards.online", {
                      count: format.number(giftCards.soldOnline.count),
                      amount: $(giftCards.soldOnline.cents),
                    })
                  : undefined
              }
              plain
            />
            <Tile label={t("giftCards.redeemed")} value={$(giftCards.redeemedCents)} plain />
            <Tile label={t("giftCards.adjusted")} value={$(giftCards.adjustedCents)} plain />
          </dl>
        </Section>
      </div>

      <Section title={t("exports.title")} hint={t("exports.hint")}>
        <ul className="flex flex-wrap gap-2">
          {EXPORT_KINDS.map((kind) => (
            <li key={kind}>
              {/* A plain link: the browser downloads the file. */}
              <a
                href={`/api/v1/admin/reports/export?${query(range, { kind, locale })}`}
                className={buttonClasses("secondary")}
                download
              >
                {t(`exports.${kind}`)}
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("notes.title")}>
        <ul className="list-disc space-y-1 ps-5 text-sm text-espresso-muted">
          <li>{t("notes.sales")}</li>
          <li>{t("notes.refunds")}</li>
          <li>{t("notes.unpaid")}</li>
        </ul>
      </Section>
    </Container>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Surface className="mb-6 flex min-w-0 flex-col gap-3">
      <h2 className="font-display text-2xl text-espresso">{title}</h2>
      {hint ? <p className="text-sm text-espresso-muted">{hint}</p> : null}
      {children}
    </Surface>
  );
}

function Tile({
  label,
  value,
  note,
  hero = false,
  plain = false,
}: {
  label: string;
  value: string;
  note?: string;
  hero?: boolean;
  plain?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        plain ? "" : "rounded-md border border-line bg-ivory-raised p-4 shadow-soft",
      )}
    >
      <dt className="text-sm text-espresso-muted">{label}</dt>
      <dd className={cn("font-semibold text-espresso", hero ? "text-4xl" : "text-2xl")}>{value}</dd>
      {note ? <dd className="text-sm text-espresso-muted">{note}</dd> : null}
    </div>
  );
}

function Table({
  head,
  rows,
  numeric,
  strongLastRow = false,
}: {
  head: string[];
  rows: string[][];
  /** Column indexes holding numbers (right-aligned, tabular figures). */
  numeric: number[];
  strongLastRow?: boolean;
}) {
  const align = (i: number) => (numeric.includes(i) ? "text-right tabular-nums" : "text-left");
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-espresso-muted">
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn("py-2 pe-4 font-semibold last:pe-0", align(i))}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, r) => (
            <tr
              key={`${r}-${row[0]}`}
              className={cn(strongLastRow && r === rows.length - 1 && "font-semibold")}
            >
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className={cn("py-2 pe-4 font-normal", align(i))}>
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn("py-2 pe-4 last:pe-0", align(i))}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
