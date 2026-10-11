"use client";

import { useRef, useState } from "react";
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
import type { PlacedOrder } from "@/server/modules/ordering/place-order";
import { RequestProblem, SlowNetworkNotice } from "@/components/NetworkStatus.client";
import { QuoteSummary } from "@/components/QuoteSummary.client";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { cart, useCartLines } from "@/lib/cart";
import { setCartExtras, useCartExtras } from "@/lib/cart-extras";
import { money } from "@/lib/format";
import { useCartQuote, type QuoteOptions } from "@/lib/use-quote";

type Tip = QuoteOptions["tip"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;
const REASONS = new Set([
  "price_changed",
  "slot_full",
  "slot_unavailable",
  "asap_unavailable",
  "ordering_unavailable",
  "cart_invalid",
  "reward_unavailable",
  "promotion_exhausted",
  "promotion_limit_reached",
  "payments_unavailable",
]);
/** Refusals that mean the offered pickup times are stale: reload them from the server. */
const TIME_REASONS = new Set([
  "slot_full",
  "slot_unavailable",
  "asap_unavailable",
  "ordering_unavailable",
]);

export interface CheckoutProps {
  pickup: PickupAvailability;
  deliveryOffered: boolean;
  usesDemoHours: boolean;
  /** False when no payment provider is configured: orders can't be placed yet. */
  paymentsEnabled: boolean;
  signedInEmail: string | null;
  signedInName: string | null;
}

/**
 * Checkout. Every amount shown comes from the server quote; on submit the server re-prices and
 * re-validates everything (time, capacity, availability, promotion, reward) and refuses a total
 * the customer didn't see. Retries reuse the same idempotency key, so a flaky network can't
 * create two orders. On success the customer continues to the payment step.
 */
export function Checkout({
  pickup,
  deliveryOffered,
  usesDemoHours,
  paymentsEnabled,
  signedInEmail,
  signedInName,
}: CheckoutProps) {
  const t = useTranslations("Checkout");
  const tCart = useTranslations("Cart");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const lines = useCartLines();
  const extras = useCartExtras();

  const [method, setMethod] = useState<"pickup" | "delivery">("pickup");
  const [postalCode, setPostalCode] = useState("");
  const [address, setAddress] = useState({
    line1: "",
    line2: "",
    city: "Montréal",
    instructions: "",
  });
  const [timing, setTiming] = useState<"asap" | "scheduled">(
    pickup.asapAvailable ? "asap" : "scheduled",
  );
  const [slot, setSlot] = useState("");
  const [tipChoice, setTipChoice] = useState<"none" | "1000" | "1500" | "1800" | "custom">("none");
  const [customTip, setCustomTip] = useState("");
  const [name, setName] = useState(signedInName ?? "");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // One key per checkout attempt; kept across network retries, renewed after a server answer.
  const idempotencyKey = useRef<string | null>(null);

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
  const postalValid = POSTAL.test(postalCode.trim());

  const { data, loading, slow, error, retry } = useCartQuote(lines, {
    promoCode: extras.promoCode || undefined,
    useReward: extras.useReward,
    fulfilment:
      method === "delivery" && postalValid
        ? { method: "delivery", postalCode: postalCode.trim() }
        : { method: "pickup" },
    tip,
    ...(method === "pickup" && timing === "scheduled" && slot ? { pickupAt: slot } : {}),
  });

  const tag = locale === "en" ? "en-CA" : "fr-CA";
  const timeFormat = new Intl.DateTimeFormat(tag, {
    timeZone: CAFE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  const dayFormat = new Intl.DateTimeFormat(tag, {
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
    name: name.trim() === "" ? t("errors.name") : undefined,
    email: !signedInEmail && !EMAIL.test(email.trim()) ? t("errors.email") : undefined,
    slot: method === "pickup" && timing === "scheduled" && !slot ? t("errors.slot") : undefined,
    tip: tipChoice === "custom" && !customValid ? t("errors.tip") : undefined,
    address:
      method === "delivery" &&
      (address.line1.trim().length < 3 || address.city.trim().length < 2 || !postalValid)
        ? t("errorsAddress")
        : undefined,
  };
  const show = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);
  const delivery = data?.delivery;

  const slotsByDay = pickup.slots.reduce<Record<string, string[]>>((acc, s) => {
    (acc[s.localDate] ??= []).push(s.startsAt);
    return acc;
  }, {});

  const placeOrder = async () => {
    setSubmitted(true);
    setRefusal(null);
    if (Object.values(errors).some(Boolean) || !data?.quote.canCheckout || loading) return;
    idempotencyKey.current ??= crypto.randomUUID();
    setPlacing(true);
    try {
      const placed = await apiFetch<PlacedOrder>("/api/v1/orders", {
        method: "POST",
        timeoutMs: 20_000,
        body: JSON.stringify({
          idempotencyKey: idempotencyKey.current,
          lines: lines.map(
            ({ lineId, productId, variantId, optionIds, quantity, notes: lineNotes }) => ({
              lineId,
              productId,
              variantId,
              optionIds,
              quantity,
              ...(lineNotes ? { notes: lineNotes } : {}),
            }),
          ),
          promoCode: extras.promoCode || undefined,
          useReward: extras.useReward,
          fulfilment:
            method === "pickup"
              ? {
                  method: "pickup",
                  when: timing === "asap" ? { kind: "asap" } : { kind: "scheduled", at: slot },
                }
              : {
                  method: "delivery",
                  address: {
                    line1: address.line1.trim(),
                    ...(address.line2.trim() ? { line2: address.line2.trim() } : {}),
                    city: address.city.trim(),
                    postalCode: postalCode.trim(),
                    ...(address.instructions.trim()
                      ? { instructions: address.instructions.trim() }
                      : {}),
                  },
                },
          tip,
          contact: {
            name: name.trim(),
            ...(signedInEmail ? {} : { email: email.trim() }),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          },
          notes: notes.trim() || undefined,
          expectedTotalCents: data.quote.totalCents,
          locale: tag,
        }),
      });
      idempotencyKey.current = null;
      cart.clear();
      setCartExtras({ promoCode: "", useReward: false });
      const token = placed.guestToken ? `?token=${encodeURIComponent(placed.guestToken)}` : "";
      router.push(`/checkout/pay/${placed.orderId}${token}`);
    } catch (e) {
      setPlacing(false);
      if (
        e instanceof ApiError &&
        (e.failure.kind === "unprocessable" || e.failure.kind === "conflict")
      ) {
        idempotencyKey.current = null;
        const reason = e.failure.reason ?? "generic";
        setRefusal(REASONS.has(reason) ? reason : "generic");
        if (reason === "price_changed") retry();
        if (TIME_REASONS.has(reason)) {
          setSlot("");
          router.refresh();
        }
        return;
      }
      // Network problem or timeout: keep the key so retrying can't create a second order.
      setRefusal(
        e instanceof ApiError && (e.failure.kind === "offline" || e.failure.kind === "timeout")
          ? "network"
          : "generic",
      );
    }
  };

  return (
    <form
      noValidate
      className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        void placeOrder();
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
            <fieldset className="flex flex-col gap-4">
              <legend className="sr-only">{t("delivery")}</legend>
              <TextField
                label={t("addressLine1")}
                name="line1"
                autoComplete="address-line1"
                value={address.line1}
                onChange={(e) => {
                  setAddress({ ...address, line1: e.currentTarget.value });
                }}
                error={show("address")}
              />
              <TextField
                label={t("addressLine2")}
                optionalLabel={tCommon("optional")}
                name="line2"
                autoComplete="address-line2"
                value={address.line2}
                onChange={(e) => {
                  setAddress({ ...address, line2: e.currentTarget.value });
                }}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label={t("city")}
                  name="city"
                  autoComplete="address-level2"
                  value={address.city}
                  onChange={(e) => {
                    setAddress({ ...address, city: e.currentTarget.value });
                  }}
                />
                <TextField
                  label={t("postalLabel")}
                  hint={t("postalHint")}
                  name="postalCode"
                  autoComplete="postal-code"
                  value={postalCode}
                  maxLength={7}
                  onChange={(e) => {
                    setPostalCode(e.currentTarget.value);
                  }}
                />
              </div>
              <TextField
                label={t("deliveryInstructions")}
                optionalLabel={tCommon("optional")}
                name="deliveryInstructions"
                value={address.instructions}
                maxLength={200}
                onChange={(e) => {
                  setAddress({ ...address, instructions: e.currentTarget.value });
                }}
              />
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
            </fieldset>
          ) : (
            <ChoiceGroup legend={t("timeLegend")} error={show("slot")}>
              {pickup.reason ? (
                <Alert tone="warning">
                  {pickup.reason === "no_hours_configured" ? t("noHours") : t("orderingDisabled")}
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
          ) : null}
          <TextField
            label={t("contactName")}
            name="name"
            autoComplete="name"
            value={name}
            maxLength={80}
            required
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
            error={show("name")}
          />
          {signedInEmail ? null : (
            <TextField
              label={t("guestEmail")}
              hint={t("guestHint")}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              required
              onChange={(e) => {
                setEmail(e.currentTarget.value);
              }}
              error={show("email")}
            />
          )}
          <TextField
            label={t("phone")}
            name="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            maxLength={20}
            onChange={(e) => {
              setPhone(e.currentTarget.value);
            }}
          />
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

          <div aria-live="assertive">
            {refusal ? (
              <Alert tone="danger" role="alert">
                {refusal === "network" ? t("reasons.generic") : t(`reasons.${refusal}`)}{" "}
                {refusal === "cart_invalid" ? (
                  <Link href="/cart" className="font-semibold underline underline-offset-4">
                    {t("backToCart")}
                  </Link>
                ) : null}
              </Alert>
            ) : null}
            {submitted && Object.values(errors).some(Boolean) ? (
              <Alert tone="danger">{t("reviewErrors")}</Alert>
            ) : null}
          </div>

          {paymentsEnabled ? (
            <>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                pending={placing}
                disabled={placing || loading || !data?.quote.canCheckout}
              >
                {placing ? t("placing") : t("placeOrder")}
              </Button>
              <p className="text-center text-sm text-espresso-muted">{t("paymentStepNote")}</p>
            </>
          ) : (
            <>
              <Alert tone="brand" title={t("paymentUnavailableTitle")} role="note">
                {t("paymentUnavailableBody")}
              </Alert>
              <Button size="lg" className="w-full" disabled>
                {t("placeOrder")}
              </Button>
            </>
          )}
          <Link href="/cart" className="text-center text-burgundy underline underline-offset-4">
            {t("backToCart")}
          </Link>
        </Surface>
      </aside>
    </form>
  );
}
