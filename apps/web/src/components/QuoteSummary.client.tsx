"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Quote } from "@ssc/domain";
import { cn } from "@ssc/ui";
import { money } from "@/lib/format";

/** Price breakdown exactly as computed by the server quote (taxes shown separately). */
export function QuoteSummary({
  quote,
  showTip = false,
  stale = false,
}: {
  quote: Quote;
  showTip?: boolean;
  stale?: boolean;
}) {
  const t = useTranslations("Cart");
  const locale = useLocale();
  const percent = (ppm: number) =>
    new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
      style: "percent",
      maximumFractionDigits: 3,
    }).format(ppm / 1_000_000);
  const rows: Array<{ label: string; cents: number; negative?: boolean; hidden?: boolean }> = [
    { label: t("subtotal"), cents: quote.subtotalCents },
    {
      label: t("discount"),
      cents: quote.discountCents,
      negative: true,
      hidden: quote.discountCents === 0,
    },
    {
      label: t("reward"),
      cents: quote.rewardDiscountCents,
      negative: true,
      hidden: quote.rewardDiscountCents === 0,
    },
    {
      label: t("deliveryFee"),
      cents: quote.deliveryFeeCents,
      hidden: quote.deliveryFeeCents === 0,
    },
    { label: `${t("gst")} (${percent(quote.gstRatePpm)})`, cents: quote.gstCents },
    { label: `${t("qst")} (${percent(quote.qstRatePpm)})`, cents: quote.qstCents },
    { label: t("tip"), cents: quote.tipCents, hidden: !showTip },
  ];
  return (
    <dl
      className={cn("flex flex-col gap-2 transition-opacity", stale ? "opacity-60" : null)}
      aria-busy={stale || undefined}
    >
      {rows
        .filter((r) => !r.hidden)
        .map((r) => (
          <div key={r.label} className="flex justify-between gap-4 text-espresso-muted">
            <dt>{r.label}</dt>
            <dd className="tabular-nums">
              {r.negative ? `−${money(r.cents, locale)}` : money(r.cents, locale)}
            </dd>
          </div>
        ))}
      <div className="mt-2 flex justify-between gap-4 border-t border-line pt-3 text-lg font-semibold text-espresso">
        <dt>{t("total")}</dt>
        <dd className="tabular-nums">{money(quote.totalCents, locale)}</dd>
      </div>
      {quote.giftCardCents > 0 ? (
        <>
          <div className="flex justify-between gap-4 text-espresso-muted">
            <dt>{t("giftCard")}</dt>
            <dd className="tabular-nums">−{money(quote.giftCardCents, locale)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-lg font-semibold text-espresso">
            <dt>{t("amountDue")}</dt>
            <dd className="tabular-nums">{money(quote.amountDueCents, locale)}</dd>
          </div>
        </>
      ) : null}
    </dl>
  );
}
