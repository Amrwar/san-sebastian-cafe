"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, ChoiceChip, ChoiceGroup, Surface, TextAreaField, TextField } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";

const PRESETS = [2500, 5000, 10000] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Buy a gift card for someone: amount, who it's for, a short note. Payment happens on the
 * provider's page; the card's code is then emailed to the recipient.
 */
export function BuyCard({
  signedIn,
  paymentsEnabled,
}: {
  signedIn: boolean;
  paymentsEnabled: boolean;
}) {
  const t = useTranslations("GiftCards.buy");
  const locale = useLocale();
  const [preset, setPreset] = useState<number | "other">(5000);
  const [other, setOther] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [purchaserName, setPurchaserName] = useState("");
  const [purchaserEmail, setPurchaserEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const otherCents = Math.round(Number(other.replace(",", ".")) * 100);
  const amountCents = preset === "other" ? otherCents : preset;
  const errors = {
    amount:
      !Number.isInteger(amountCents) || amountCents < 1000 || amountCents > 20_000
        ? t("errors.amount")
        : undefined,
    recipientName: recipientName.trim() === "" ? t("errors.name") : undefined,
    recipientEmail: EMAIL.test(recipientEmail.trim()) ? undefined : t("errors.email"),
    purchaserName: purchaserName.trim() === "" ? t("errors.name") : undefined,
    purchaserEmail: signedIn || EMAIL.test(purchaserEmail.trim()) ? undefined : t("errors.email"),
  };
  const show = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);

  const submit = async () => {
    setSubmitted(true);
    setProblem(null);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true);
    try {
      const started = await apiFetch<{ url: string }>("/api/v1/gift-cards/purchases", {
        method: "POST",
        body: JSON.stringify({
          amountCents,
          recipientName: recipientName.trim(),
          recipientEmail: recipientEmail.trim(),
          ...(message.trim() ? { message: message.trim() } : {}),
          purchaserName: purchaserName.trim(),
          ...(signedIn ? {} : { purchaserEmail: purchaserEmail.trim() }),
          locale: locale === "en" ? "en" : "fr",
        }),
      });
      // The provider's hosted page (or, in development, the simulator on our purchase page).
      window.location.assign(started.url);
    } catch (e) {
      setBusy(false);
      const kind = e instanceof ApiError ? e.failure.kind : null;
      setProblem(kind === "rate_limited" ? t("errors.tooMany") : t("errors.generic"));
    }
  };

  return (
    <Surface as="section" aria-labelledby="buy-title" className="flex flex-col gap-5">
      <div>
        <h2 id="buy-title" className="text-lg font-semibold text-espresso">
          {t("title")}
        </h2>
        <p className="text-sm text-espresso-muted">{t("intro")}</p>
      </div>
      {!paymentsEnabled ? (
        <Alert tone="brand" role="note">
          {t("unavailable")}
        </Alert>
      ) : (
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ChoiceGroup legend={t("amount")} error={show("amount")}>
            {PRESETS.map((cents) => (
              <ChoiceChip
                key={cents}
                type="radio"
                name="amount"
                label={money(cents, locale)}
                checked={preset === cents}
                onChange={() => {
                  setPreset(cents);
                }}
              />
            ))}
            <ChoiceChip
              type="radio"
              name="amount"
              label={t("otherAmount")}
              checked={preset === "other"}
              onChange={() => {
                setPreset("other");
              }}
            />
          </ChoiceGroup>
          {preset === "other" ? (
            <TextField
              label={t("otherLabel")}
              hint={t("otherHint")}
              inputMode="decimal"
              className="w-48"
              value={other}
              onChange={(e) => {
                setOther(e.currentTarget.value);
              }}
            />
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("recipientName")}
              autoComplete="off"
              value={recipientName}
              error={show("recipientName")}
              onChange={(e) => {
                setRecipientName(e.currentTarget.value);
              }}
            />
            <TextField
              label={t("recipientEmail")}
              hint={t("recipientEmailHint")}
              type="email"
              autoComplete="off"
              value={recipientEmail}
              error={show("recipientEmail")}
              onChange={(e) => {
                setRecipientEmail(e.currentTarget.value);
              }}
            />
          </div>
          <TextAreaField
            label={t("message")}
            hint={t("messageHint")}
            maxLength={300}
            rows={3}
            value={message}
            onChange={(e) => {
              setMessage(e.currentTarget.value);
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("purchaserName")}
              autoComplete="name"
              value={purchaserName}
              error={show("purchaserName")}
              onChange={(e) => {
                setPurchaserName(e.currentTarget.value);
              }}
            />
            {signedIn ? null : (
              <TextField
                label={t("purchaserEmail")}
                hint={t("purchaserEmailHint")}
                type="email"
                autoComplete="email"
                value={purchaserEmail}
                error={show("purchaserEmail")}
                onChange={(e) => {
                  setPurchaserEmail(e.currentTarget.value);
                }}
              />
            )}
          </div>
          <div aria-live="assertive">
            {problem ? (
              <Alert tone="danger" role="alert">
                {problem}
              </Alert>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Button type="submit" size="lg" pending={busy} disabled={busy}>
              {amountCents >= 1000 && amountCents <= 20_000
                ? t("pay", { amount: money(amountCents, locale) })
                : t("payNoAmount")}
            </Button>
            <p className="text-sm text-espresso-muted">{t("noTax")}</p>
          </div>
        </form>
      )}
    </Surface>
  );
}
