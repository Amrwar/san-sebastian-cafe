"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Alert,
  Badge,
  Button,
  buttonClasses,
  CheckboxField,
  EmptyState,
  QuantityStepper,
  Skeleton,
  Surface,
  TextField,
} from "@ssc/ui";
import { TrashIcon } from "@/components/icons";
import { RequestProblem, SlowNetworkNotice } from "@/components/NetworkStatus.client";
import { QuoteSummary } from "@/components/QuoteSummary.client";
import { Link } from "@/i18n/navigation";
import { cart, useCartLines } from "@/lib/cart";
import { setCartExtras, useCartExtras } from "@/lib/cart-extras";
import { money, pick } from "@/lib/format";
import { useCartQuote } from "@/lib/use-quote";

export function Cart({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations("Cart");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const lines = useCartLines();
  const extras = useCartExtras();
  const [promoDraft, setPromoDraft] = useState(extras.promoCode);
  const [announcement, setAnnouncement] = useState("");

  const {
    data: result,
    loading: busy,
    slow,
    error,
    retry,
  } = useCartQuote(lines, {
    promoCode: extras.promoCode || undefined,
    useReward: extras.useReward,
    fulfilment: { method: "pickup" },
    tip: { kind: "none" },
  });

  if (lines.length === 0) {
    return (
      <EmptyState
        title={t("emptyTitle")}
        action={
          <Link href="/menu" className={buttonClasses("primary")}>
            {t("browseMenu")}
          </Link>
        }
      >
        {t("emptyBody")}
      </EmptyState>
    );
  }

  if (!result) {
    return (
      <div className="flex flex-col gap-4">
        {error ? <RequestProblem failure={error} onRetry={retry} /> : null}
        {slow ? <SlowNetworkNotice /> : null}
        <p role="status" className="sr-only">
          {tCommon("loading")}
        </p>
        {lines.map((l) => (
          <Skeleton key={l.lineId} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  const { quote, display } = result;
  const promo = quote.promotion;
  const reward = quote.reward;
  const availableRewards = result.availableRewardIds?.length ?? 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
      <section aria-labelledby="cart-lines-title" className="flex flex-col gap-4">
        <h2 id="cart-lines-title" className="sr-only">
          {t("title")}
        </h2>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        {error ? <RequestProblem failure={error} onRetry={retry} /> : null}
        {display.some((d) => d.isDemo) ? (
          <Alert tone="warning" role="note">
            {t("demoItems")}
          </Alert>
        ) : null}
        <ul className="flex flex-col gap-3">
          {quote.lines.map((line) => {
            const d = display.find((x) => x.lineId === line.lineId);
            const name = d ? pick(d, "name", locale) : "";
            const variant = d ? pick(d, "variantName", locale) : "";
            const options = d?.options.map((o) => pick(o, "name", locale)) ?? [];
            const stored = lines.find((l) => l.lineId === line.lineId);
            return (
              <li key={line.lineId}>
                <Surface as="article" className={line.valid ? "" : "border-danger/40"}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-espresso">
                        {name}
                        {d?.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                      </h3>
                      <p className="text-sm text-espresso-muted">
                        {[variant, ...options].filter(Boolean).join(" · ")}
                      </p>
                      {line.issues.length > 0 ? (
                        <ul className="mt-1 text-sm font-medium text-danger">
                          {[...new Set(line.issues.map((i) => i.code))].map((code) => (
                            <li key={code}>{t(`issues.${code}`)}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <p className="text-lg font-semibold tabular-nums text-espresso">
                      {line.valid ? money(line.lineTotalCents, locale) : "—"}
                    </p>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <QuantityStepper
                      value={stored?.quantity ?? line.quantity}
                      onChange={(q) => {
                        cart.setQuantity(line.lineId, q);
                      }}
                      label={t("quantityFor", { name })}
                      decreaseLabel={t("decrease")}
                      increaseLabel={t("increase")}
                    />
                    {d?.slug ? (
                      <Link
                        href={`/menu/${d.slug}?edit=${encodeURIComponent(line.lineId)}`}
                        className={buttonClasses("ghost", "md")}
                      >
                        {t("edit")}
                      </Link>
                    ) : null}
                    <Button
                      variant="ghost"
                      aria-label={t("removeLabel", { name })}
                      onClick={() => {
                        cart.remove(line.lineId);
                        setAnnouncement(t("removed", { name }));
                      }}
                    >
                      <TrashIcon className="size-5" />
                      {tCommon("remove")}
                    </Button>
                  </div>
                </Surface>
              </li>
            );
          })}
        </ul>
      </section>

      <aside className="flex flex-col gap-5 lg:sticky lg:top-24">
        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("rewardTitle")}</h2>
          {!signedIn ? (
            <p className="text-sm text-espresso-muted">
              <Link
                href={`/sign-in?next=${encodeURIComponent(`/${locale}/cart`)}`}
                className="text-burgundy underline underline-offset-4"
              >
                {t("rewardSignIn")}
              </Link>
            </p>
          ) : availableRewards === 0 ? (
            <p className="text-sm text-espresso-muted">{t("rewardNone")}</p>
          ) : (
            <>
              <CheckboxField
                label={t("rewardUse")}
                hint={t("rewardAvailable", { count: availableRewards })}
                checked={extras.useReward}
                onChange={(e) => {
                  setCartExtras({ useReward: e.currentTarget.checked });
                }}
              />
              {extras.useReward && reward?.status === "no_eligible_item" ? (
                <p className="text-sm font-medium text-warning">{t("rewardNoEligible")}</p>
              ) : null}
            </>
          )}

          <form
            className="flex flex-col gap-2 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              setCartExtras({ promoCode: promoDraft.trim() });
            }}
          >
            <div className="flex items-end gap-2">
              <TextField
                className="flex-1"
                label={t("promoLabel")}
                name="promo"
                value={promoDraft}
                maxLength={32}
                autoCapitalize="characters"
                onChange={(e) => {
                  setPromoDraft(e.currentTarget.value);
                }}
                error={promo && promo.status !== "applied" ? t(`promo.${promo.status}`) : undefined}
              />
              <Button type="submit" variant="secondary">
                {t("promoApply")}
              </Button>
            </div>
            {promo?.status === "applied" ? (
              <p className="text-sm font-medium text-success">{t("promo.applied")}</p>
            ) : null}
            {extras.promoCode ? (
              <button
                type="button"
                className="self-start text-sm text-burgundy underline underline-offset-4"
                onClick={() => {
                  setPromoDraft("");
                  setCartExtras({ promoCode: "" });
                }}
              >
                {t("promoRemove")}
              </button>
            ) : null}
          </form>
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("summaryTitle")}</h2>
          <QuoteSummary quote={quote} stale={busy} />
          {busy ? (
            <p role="status" className="text-sm text-espresso-muted">
              {t("updating")}
            </p>
          ) : null}
          {slow ? <SlowNetworkNotice /> : null}
          {quote.issues.includes("invalid_lines") ? (
            <p className="text-sm font-medium text-danger">{t("fixLines")}</p>
          ) : null}
          {quote.canCheckout && !busy ? (
            <Link href="/checkout" className={buttonClasses("primary", "lg", "w-full")}>
              {t("checkout")}
            </Link>
          ) : (
            <Button size="lg" className="w-full" disabled>
              {t("checkout")}
            </Button>
          )}
        </Surface>
      </aside>
    </div>
  );
}
