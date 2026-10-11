"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CAFE_TIME_ZONE, type PickupAvailability } from "@ssc/domain";
import {
  Alert,
  Button,
  buttonClasses,
  ChoiceChip,
  ChoiceGroup,
  EmptyState,
  SelectField,
  Skeleton,
  Surface,
  TextField,
} from "@ssc/ui";
import { RequestProblem, SlowNetworkNotice } from "@/components/NetworkStatus.client";
import { QuoteSummary } from "@/components/QuoteSummary.client";
import { Link } from "@/i18n/navigation";
import { useCartLines } from "@/lib/cart";
import { useCartExtras } from "@/lib/cart-extras";
import { money } from "@/lib/format";
import { useCartQuote, type QuoteOptions } from "@/lib/use-quote";

type Tip = QuoteOptions["tip"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

export interface CheckoutProps {
  pickup: PickupAvailability;
  deliveryOffered: boolean;
  usesDemoHours: boolean;
  signedInEmail: string | null;
  signedInName: string | null;
}

/**
 * Checkout review. Everything shown is computed by the server; placing an order stays disabled
 * until payments and order placement exist (Phase 6). No order is created and nothing is charged.
 */
export function Checkout({
  pickup,
  deliveryOffered,
  usesDemoHours,
  signedInEmail,
  signedInName,
}: CheckoutProps) {
  const t = useTranslations("Checkout");
  const tCart = useTranslations("Cart");
  const locale = useLocale();
  const lines = useCartLines();
  const extras = useCartExtras();

  const [method, setMethod] = useState<"pickup" | "delivery">("pickup");
  const [postalDraft, setPostalDraft] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [timing, setTiming] = useState<"asap" | "scheduled">(
    pickup.asapAvailable ? "asap" : "scheduled",
  );
  const [slot, setSlot] = useState("");
  const [tipChoice, setTipChoice] = useState<"none" | "1000" | "1500" | "1800" | "custom">("none");
  const [customTip, setCustomTip] = useState("");
  const [guestName, setGuestName] = useState(signedInName ?? "");
  const [guestEmail, setGuestEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const customCents = Math.round(Number(customTip.replace(",", ".")) * 100);
  const customValid =
    customTip === "" || (Number.isFinite(customCents) && customCents >= 0 && customCents <= 10_000);
  const tip: Tip =
    tipChoice === "none"
      ? { kind: "none" }
      : tipChoice === "custom"
        ? customValid && customTip !== ""
          ? { kind: "amount", cents: customCents }
          : { kind: "none" }
        : { kind: "percent", basisPoints: Number(tipChoice) };

  const { data, loading, slow, error, retry } = useCartQuote(lines, {
    promoCode: extras.promoCode || undefined,
    useReward: extras.useReward,
    fulfilment:
      method === "delivery" && postalCode
        ? { method: "delivery", postalCode }
        : { method: "pickup" },
    tip,
  });

  const timeFormat = new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
    timeZone: CAFE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  const dayFormat = new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
    timeZone: CAFE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  if (lines.length === 0) {
    return (
      <EmptyState
        title={tCart("emptyTitle")}
        action={
          <Link href="/menu" className={buttonClasses("primary")}>
            {tCart("browseMenu")}
          </Link>
        }
      >
        {tCart("emptyBody")}
      </EmptyState>
    );
  }

  const errors = {
    name: !signedInEmail && guestName.trim() === "" ? t("errors.name") : undefined,
    email: !signedInEmail && !EMAIL.test(guestEmail.trim()) ? t("errors.email") : undefined,
    slot: method === "pickup" && timing === "scheduled" && !slot ? t("errors.slot") : undefined,
    tip: tipChoice === "custom" && !customValid ? t("errors.tip") : undefined,
  };
  const show = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);
  const reviewOk =
    submitted && Object.values(errors).every((e) => !e) && data?.quote.canCheckout === true;
  const delivery = data?.delivery;

  // Group slots by local day for the picker.
  const slotsByDay = pickup.slots.reduce<Record<string, string[]>>((acc, s) => {
    (acc[s.localDate] ??= []).push(s.startsAt);
    return acc;
  }, {});

  return (
    <form
      noValidate
      className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
      }}
    >
      <div className="flex flex-col gap-6">
        <Surface className="flex flex-col gap-5">
          <ChoiceGroup legend={t("fulfilmentLegend")}>
            <ChoiceChip
              type="radio"
              name="fulfilment"
              value="pickup"
              checked={method === "pickup"}
              onChange={() => {
                setMethod("pickup");
              }}
              label={t("pickup")}
            />
            <ChoiceChip
              type="radio"
              name="fulfilment"
              value="delivery"
              checked={method === "delivery"}
              disabled={!deliveryOffered}
              onChange={() => {
                setMethod("delivery");
              }}
              label={t("delivery")}
              unavailableLabel={t("deliveryUnavailable")}
            />
          </ChoiceGroup>

          {method === "delivery" ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <TextField
                  className="flex-1"
                  label={t("postalLabel")}
                  hint={t("postalHint")}
                  name="postalCode"
                  autoComplete="postal-code"
                  value={postalDraft}
                  maxLength={7}
                  onChange={(e) => {
                    setPostalDraft(e.currentTarget.value);
                  }}
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPostalCode(postalDraft.trim());
                  }}
                  disabled={!POSTAL.test(postalDraft.trim())}
                >
                  {t("postalCheck")}
                </Button>
              </div>
              {delivery && delivery.status !== "not_requested" ? (
                <p
                  role="status"
                  className={
                    delivery.status === "available"
                      ? "text-sm font-medium text-success"
                      : "text-sm font-medium text-danger"
                  }
                >
                  {delivery.status === "available"
                    ? t("deliveryStatus.available", {
                        zone: locale === "en" ? delivery.zoneNameEn : delivery.zoneNameFr,
                        minutes: delivery.estimatedMinutes,
                      })
                    : t(`deliveryStatus.${delivery.status}`)}
                </p>
              ) : null}
            </div>
          ) : (
            <ChoiceGroup legend={t("timeLegend")} error={show("slot")}>
              {pickup.reason ? (
                <Alert tone="warning">
                  {pickup.reason === "ordering_disabled" ? t("orderingDisabled") : t("noHours")}
                </Alert>
              ) : (
                <div className="flex w-full flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <ChoiceChip
                      type="radio"
                      name="timing"
                      value="asap"
                      checked={timing === "asap"}
                      disabled={!pickup.asapAvailable}
                      onChange={() => {
                        setTiming("asap");
                      }}
                      label={t("asap")}
                      detail={
                        pickup.asapReadyAt
                          ? t("asapReady", {
                              time: timeFormat.format(new Date(pickup.asapReadyAt)),
                            })
                          : undefined
                      }
                      unavailableLabel={t("asapClosed")}
                    />
                    <ChoiceChip
                      type="radio"
                      name="timing"
                      value="scheduled"
                      checked={timing === "scheduled"}
                      disabled={pickup.slots.length === 0}
                      onChange={() => {
                        setTiming("scheduled");
                      }}
                      label={t("scheduled")}
                      unavailableLabel={t("noSlots")}
                    />
                  </div>
                  {timing === "scheduled" && pickup.slots.length > 0 ? (
                    <SelectField
                      label={t("slotLabel")}
                      name="slot"
                      value={slot}
                      onChange={(e) => {
                        setSlot(e.currentTarget.value);
                      }}
                      error={show("slot")}
                    >
                      <option value="">—</option>
                      {Object.entries(slotsByDay).map(([day, starts]) => (
                        <optgroup key={day} label={dayFormat.format(new Date(starts[0] ?? day))}>
                          {starts.map((iso) => (
                            <option key={iso} value={iso}>
                              {timeFormat.format(new Date(iso))}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </SelectField>
                  ) : null}
                  {usesDemoHours ? (
                    <p className="text-sm text-espresso-muted">{t("demoHours")}</p>
                  ) : null}
                </div>
              )}
            </ChoiceGroup>
          )}
        </Surface>

        <Surface className="flex flex-col gap-5">
          <h2 className="font-display text-2xl text-espresso">{t("contactTitle")}</h2>
          {signedInEmail ? (
            <p className="text-espresso-muted">{t("signedInAs", { email: signedInEmail })}</p>
          ) : (
            <>
              <TextField
                label={t("guestName")}
                name="name"
                autoComplete="name"
                value={guestName}
                maxLength={80}
                required
                onChange={(e) => {
                  setGuestName(e.currentTarget.value);
                }}
                error={show("name")}
              />
              <TextField
                label={t("guestEmail")}
                hint={t("guestHint")}
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={guestEmail}
                required
                onChange={(e) => {
                  setGuestEmail(e.currentTarget.value);
                }}
                error={show("email")}
              />
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="order-notes" className="text-sm font-semibold text-espresso">
              {t("notesLabel")}
            </label>
            <p id="order-notes-hint" className="text-sm text-espresso-muted">
              {t("notesHint")}
            </p>
            <textarea
              id="order-notes"
              aria-describedby="order-notes-hint"
              maxLength={200}
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.currentTarget.value);
              }}
              className="block w-full rounded-sm border border-line-strong bg-ivory-raised px-3.5 py-2.5 text-base text-espresso focus-visible:border-burgundy"
            />
          </div>
        </Surface>

        <Surface>
          {/* Québec: suggestions on the pre-tax amount, equal visual weight, custom and no-tip options. */}
          <ChoiceGroup
            legend={t("tipLegend")}
            hint={
              data ? t("tipHint", { amount: money(data.quote.tipBaseCents, locale) }) : undefined
            }
            error={show("tip")}
          >
            <ChoiceChip
              type="radio"
              name="tip"
              value="none"
              checked={tipChoice === "none"}
              onChange={() => {
                setTipChoice("none");
              }}
              label={t("tipNone")}
            />
            {(data?.quote.tipSuggestions ?? []).map((s) => (
              <ChoiceChip
                key={s.basisPoints}
                type="radio"
                name="tip"
                value={String(s.basisPoints)}
                checked={tipChoice === String(s.basisPoints)}
                onChange={() => {
                  setTipChoice(String(s.basisPoints) as "1000" | "1500" | "1800");
                }}
                label={t("tipPercent", { percent: s.basisPoints / 100 })}
                detail={money(s.cents, locale)}
              />
            ))}
            <ChoiceChip
              type="radio"
              name="tip"
              value="custom"
              checked={tipChoice === "custom"}
              onChange={() => {
                setTipChoice("custom");
              }}
              label={t("tipCustom")}
            />
          </ChoiceGroup>
          {tipChoice === "custom" ? (
            <TextField
              className="mt-4 max-w-48"
              label={t("tipCustomLabel")}
              name="customTip"
              inputMode="decimal"
              value={customTip}
              onChange={(e) => {
                setCustomTip(e.currentTarget.value);
              }}
              error={customValid ? undefined : t("errors.tip")}
            />
          ) : null}
        </Surface>
      </div>

      <aside className="flex flex-col gap-5 lg:sticky lg:top-24">
        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("summaryTitle")}</h2>
          {error ? <RequestProblem failure={error} onRetry={retry} /> : null}
          {slow ? <SlowNetworkNotice /> : null}
          {data ? (
            <QuoteSummary quote={data.quote} showTip stale={loading} />
          ) : (
            <div className="flex flex-col gap-2" aria-hidden="true">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          )}
          {data && !data.quote.canCheckout ? (
            <Alert tone="danger">
              {tCart("fixLines")}{" "}
              <Link href="/cart" className="font-semibold underline underline-offset-4">
                {t("backToCart")}
              </Link>
            </Alert>
          ) : null}
          <Alert tone="brand" title={t("paymentUnavailableTitle")} role="note">
            {t("paymentUnavailableBody")}
          </Alert>
          <Button type="submit" variant="secondary" size="lg" className="w-full">
            {t("review")}
          </Button>
          <div aria-live="polite">
            {reviewOk ? <Alert tone="success">{t("reviewOk")}</Alert> : null}
            {submitted && !reviewOk && Object.values(errors).some(Boolean) ? (
              <Alert tone="danger">{t("reviewErrors")}</Alert>
            ) : null}
          </div>
          <Button size="lg" className="w-full" disabled aria-describedby="payment-unavailable">
            {t("placeOrder")}
          </Button>
          <p id="payment-unavailable" className="sr-only">
            {t("paymentUnavailableTitle")}
          </p>
          <Link href="/cart" className="text-center text-burgundy underline underline-offset-4">
            {t("backToCart")}
          </Link>
        </Surface>
      </aside>
    </form>
  );
}
