import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Container, Surface } from "@ssc/ui";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { getOrderDetail, type OrderDetail } from "@/server/modules/ordering/customer-orders";
import { orderPaymentSummary } from "@/server/modules/payments/history";
import { getSessionUser, requireSessionUser } from "@/server/session";
import { PrintButton } from "./PrintButton.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/orders/[id]/receipt">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "PaymentInfo" });
  return { title: t("receipt"), robots: { index: false } };
}

/**
 * Printable order and payment confirmation. Not the Québec SRS bill (risk R1) — it says so — and
 * the café's tax registration numbers are placeholders until the owner supplies them.
 */
export default async function ReceiptPage({
  params,
  searchParams,
}: PageProps<"/[locale]/orders/[id]/receipt">) {
  const { locale, id } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  const user = token
    ? await getSessionUser()
    : await requireSessionUser(locale, `/${locale}/orders/${id}/receipt`);

  let order: OrderDetail;
  try {
    order = await getOrderDetail(db(), user, id, token);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }
  const [t, tInfo, tCart, format, payment] = await Promise.all([
    getTranslations("Receipt"),
    getTranslations("PaymentInfo"),
    getTranslations("Cart"),
    getFormatter(),
    orderPaymentSummary(db(), order.id),
  ]);
  const en = locale === "en";
  const [titleBefore = "", titleAfter = ""] = t("title", { number: "\u0000" }).split("\u0000");
  const totals = order.totals;
  const rows = [
    { label: tCart("subtotal"), cents: totals.subtotalCents },
    { label: tCart("discount"), cents: -totals.discountCents, hide: totals.discountCents === 0 },
    {
      label: tCart("reward"),
      cents: -totals.rewardDiscountCents,
      hide: totals.rewardDiscountCents === 0,
    },
    {
      label: tCart("deliveryFee"),
      cents: totals.deliveryFeeCents,
      hide: totals.deliveryFeeCents === 0,
    },
    { label: tCart("gst"), cents: totals.gstCents },
    { label: tCart("qst"), cents: totals.qstCents },
    { label: tCart("tip"), cents: totals.tipCents, hide: totals.tipCents === 0 },
  ].filter((r) => !r.hide);
  const amount = (cents: number) =>
    cents < 0 ? `−${money(-cents, locale)}` : money(cents, locale);
  const date = (d: Date | string) =>
    format.dateTime(new Date(d), { dateStyle: "long", timeStyle: "short" });

  return (
    <Container className="max-w-xl py-8">
      <Surface className="flex flex-col gap-5 print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-display text-2xl text-espresso">{t("cafe")}</p>
            <p className="text-sm text-espresso-muted">{t("address")}</p>
            <p className="text-sm text-espresso-muted" title={t("taxNumbersNote")}>
              {t("taxNumbers")}
            </p>
          </div>
          <PrintButton label={t("print")} />
        </header>
        <div>
          <h1 className="font-display text-3xl text-espresso">
            {titleBefore}
            {/* The number is read out at the counter: never split at its hyphen. */}
            <span className="whitespace-nowrap">{order.number}</span>
            {titleAfter}
          </h1>
          <p className="text-espresso-muted">{t("date", { date: date(order.placedAt) })}</p>
        </div>

        <table className="w-full text-left">
          <tbody className="divide-y divide-line">
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="py-2 pe-4 align-top">
                  {item.quantity} × {en ? item.productNameEn : item.productNameFr}
                  <span className="block text-sm text-espresso-muted">
                    {[
                      en ? item.variantNameEn : item.variantNameFr,
                      ...item.modifiers.map((m) => (en ? m.nameEn : m.nameFr)),
                    ].join(" · ")}
                  </span>
                </td>
                <td className="py-2 text-end align-top tabular-nums">
                  {money(item.lineTotalCents, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="flex flex-col gap-1 border-t border-line pt-3">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-4 text-espresso-muted">
              <dt>{r.label}</dt>
              <dd className="tabular-nums">{amount(r.cents)}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t border-line pt-2 text-lg font-semibold text-espresso">
            <dt>{tCart("total")}</dt>
            <dd className="tabular-nums">{money(totals.totalCents, locale)}</dd>
          </div>
        </dl>

        <section className="flex flex-col gap-1">
          <h2 className="font-semibold text-espresso">{t("payment")}</h2>
          {payment.paid ? (
            <p>
              {payment.paid.cardBrand && payment.paid.cardLast4
                ? tInfo("paidWith", {
                    amount: money(payment.paid.amountCents, locale),
                    brand: payment.paid.cardBrand,
                    last4: payment.paid.cardLast4,
                  })
                : tInfo("paidAmount", { amount: money(payment.paid.amountCents, locale) })}
              {payment.paid.paidAt ? ` — ${date(payment.paid.paidAt)}` : null}
            </p>
          ) : (
            <p>{t("notPaid")}</p>
          )}
        </section>

        {payment.refunds.length > 0 ? (
          <section className="flex flex-col gap-1">
            <h2 className="font-semibold text-espresso">{t("refunds")}</h2>
            {payment.refunds.map((r) => (
              <p key={r.id}>
                {tInfo("refundLine", { amount: money(r.amountCents, locale) })} —{" "}
                {tInfo(`refundStatus.${r.status}`)} ({date(r.settledAt ?? r.createdAt)})
              </p>
            ))}
          </section>
        ) : null}

        <Alert tone="neutral">{t("legalNote")}</Alert>
      </Surface>
    </Container>
  );
}
