import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Surface } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import type { OrderPaymentSummary } from "@/server/modules/payments/history";

/** How the order was paid and what was refunded (card brand and last 4 digits only). */
export async function PaymentInfo({
  summary,
  locale,
  receiptHref,
}: {
  summary: OrderPaymentSummary;
  locale: string;
  receiptHref: string | null;
}) {
  const [t, format] = await Promise.all([getTranslations("PaymentInfo"), getFormatter()]);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const { paid } = summary;

  return (
    <Surface className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl text-espresso">{t("title")}</h2>
        <Badge tone={summary.state === "paid" ? "success" : "neutral"}>
          {t(`state.${summary.state}`)}
        </Badge>
      </div>
      {paid ? (
        <p className="text-espresso">
          {paid.cardBrand && paid.cardLast4
            ? t("paidWith", {
                amount: money(paid.amountCents, locale),
                brand: paid.cardBrand,
                last4: paid.cardLast4,
              })
            : t("paidAmount", { amount: money(paid.amountCents, locale) })}
          {paid.paidAt ? ` ${t("paidOn", { date: date(paid.paidAt) })}` : null}
        </p>
      ) : null}
      {summary.refunds.length > 0 ? (
        <ul className="flex flex-col gap-1 text-espresso">
          {summary.refunds.map((r) => (
            <li key={r.id}>
              {t("refundLine", { amount: money(r.amountCents, locale) })} —{" "}
              {t(`refundStatus.${r.status}`)} ({date(r.settledAt ?? r.createdAt)})
            </li>
          ))}
        </ul>
      ) : null}
      {summary.refunds.some((r) => r.status === "pending" || r.status === "succeeded") ? (
        <p className="text-sm text-espresso-muted">{t("refundDelay")}</p>
      ) : null}
      {summary.returnedPayments.map((p, i) => (
        <p key={i} className="text-sm text-espresso-muted">
          {t("returned", { amount: money(p.amountCents, locale) })}
        </p>
      ))}
      {receiptHref && paid ? (
        <Link href={receiptHref} className="self-start text-burgundy underline underline-offset-4">
          {t("receipt")}
        </Link>
      ) : null}
    </Surface>
  );
}
