import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, buttonClasses, Container, PageHeader, Surface } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { paymentsNeedingAttention, staffOrderPayments } from "@/server/modules/payments/history";
import { requirePermissionForPage } from "@/server/session";
import { RefundForm } from "./RefundForm.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff/payments">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "StaffPayments" });
  return { title: t("title"), robots: { index: false } };
}

const REFUND_SOURCES = ["staff", "customer_cancel", "system", "provider"] as const;

/** Payments, refunds (with their audit trail) and disputes, for shift leads and above. */
export default async function StaffPaymentsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/staff/payments">) {
  const { locale } = await params;
  const sp = await searchParams;
  const number = typeof sp.number === "string" ? sp.number.trim() : "";
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/staff/payments`,
    "orders:refund",
  );
  if (access.status === "forbidden") return <Forbidden />;

  const [t, tStatus, tHistory, format, attention, found] = await Promise.all([
    getTranslations("StaffPayments"),
    getTranslations("OrderStatus"),
    getTranslations("PaymentHistory"),
    getFormatter(),
    paymentsNeedingAttention(db(), access.user),
    number ? staffOrderPayments(db(), access.user, number) : Promise.resolve(null),
  ]);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const refundable = found?.payments.find((p) => p.reconciliation === null)?.refundableCents ?? 0;
  const source = (s: string) =>
    (REFUND_SOURCES as readonly string[]).includes(s)
      ? t(`source.${s as (typeof REFUND_SOURCES)[number]}`)
      : s;

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <Link href="/staff" className={`${buttonClasses("secondary")} mb-6`}>
        {t("back")}
      </Link>

      <div className="flex flex-col gap-6">
        <Surface className="flex flex-col gap-3">
          <h2 className="font-display text-2xl text-espresso">{t("attention")}</h2>
          {attention.length === 0 ? (
            <p className="text-espresso-muted">{t("attentionEmpty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.kind === "refund_pending" ? "warning" : "danger"}>
                      {t(`kinds.${a.kind}`)}
                    </Badge>
                    {a.orderNumber ? (
                      <Link
                        href={`/staff/payments?number=${encodeURIComponent(a.orderNumber)}`}
                        className="underline underline-offset-4"
                      >
                        {a.orderNumber}
                      </Link>
                    ) : null}
                    <span className="text-sm text-espresso-muted">{date(a.at)}</span>
                  </span>
                  <span className="tabular-nums">{money(a.amountCents, locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <form className="flex flex-wrap items-end gap-3" role="search">
          <label className="flex flex-col gap-1 text-sm font-semibold text-espresso">
            {t("search")}
            <input
              name="number"
              defaultValue={number}
              placeholder="1012-001"
              className="min-h-11 rounded-sm border border-line-strong bg-ivory-raised px-3 text-base font-normal"
            />
          </label>
          <button type="submit" className={buttonClasses("primary")}>
            {t("searchButton")}
          </button>
        </form>

        {number && !found ? <Alert tone="neutral">{t("notFound")}</Alert> : null}

        {found ? (
          <Surface className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-3xl text-espresso">{found.order.number}</h2>
              <Badge tone="brand">{tStatus(found.order.status)}</Badge>
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-espresso">{t("payments")}</h3>
              {found.payments.length === 0 ? <p>{t("none")}</p> : null}
              {found.payments.map((p) => (
                <div key={p.id} className="rounded-sm border border-line p-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums">
                      {money(p.amountCents, locale)}
                    </span>
                    <Badge tone="neutral">{tHistory(`status.${p.status}`)}</Badge>
                    {p.reconciliation ? (
                      <Badge tone="warning">{t(`reconciliation.${p.reconciliation}`)}</Badge>
                    ) : null}
                  </p>
                  <p className="text-sm break-all text-espresso-muted">
                    {p.provider} · {p.providerPaymentId}
                    {p.cardBrand ? ` · ${p.cardBrand} •••• ${p.cardLast4 ?? ""}` : ""}
                    {p.paidAt ? ` · ${date(p.paidAt)}` : ""}
                  </p>
                  {p.reconciliation === null ? (
                    <p className="text-sm">
                      {t("refundable", { amount: money(p.refundableCents, locale) })}
                    </p>
                  ) : null}
                </div>
              ))}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-espresso">{t("refunds")}</h3>
              {found.refunds.length === 0 ? <p>{t("none")}</p> : null}
              <ul className="flex flex-col gap-2">
                {found.refunds.map((r) => (
                  <li key={r.id} className="rounded-sm border border-line p-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold tabular-nums">
                        {money(r.amountCents, locale)}
                      </span>
                      <Badge tone={r.status === "failed" ? "danger" : "neutral"}>
                        {tHistory(`status.${r.status}`)}
                      </Badge>
                      <span className="text-sm">{source(r.source)}</span>
                    </p>
                    <p className="text-sm text-espresso-muted">
                      {r.reason}
                      {r.requestedBy
                        ? ` — ${t("requestedBy", { name: r.requestedBy })}`
                        : ""} · {date(r.createdAt)}
                      {r.failureReason ? ` · ${r.failureReason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            {found.disputes.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h3 className="font-semibold text-espresso">{t("disputes")}</h3>
                {found.disputes.map((d) => (
                  <Alert key={d.id} tone="warning">
                    {money(d.amountCents, locale)} · {d.reason ?? "—"} · {d.status}
                    {d.evidenceDueBy
                      ? ` · ${t("evidenceDue", { date: date(d.evidenceDueBy) })}`
                      : ""}
                    <br />
                    {t("disputeHelp")}
                  </Alert>
                ))}
              </section>
            ) : null}

            {refundable > 0 ? <RefundForm orderId={found.order.id} maxCents={refundable} /> : null}

            <details>
              <summary className="cursor-pointer text-sm text-espresso-muted">
                {t("attempts")}
              </summary>
              <ul className="mt-2 text-sm text-espresso-muted">
                {found.attempts.map((a) => (
                  <li key={a.id}>
                    {date(a.createdAt)} · {a.status}
                    {a.lastError ? ` · ${a.lastError}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          </Surface>
        ) : null}
      </div>
    </Container>
  );
}
