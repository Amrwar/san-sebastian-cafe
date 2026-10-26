"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  EARN_TRIGGERS,
  LOYALTY_RULE_LIMITS as L,
  REFUND_SHORTFALL_POLICIES,
  REWARD_REFUND_POLICIES,
  type LoyaltyRules,
} from "@ssc/domain";
import { Alert, Button, CheckboxField, SelectField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { ProgramInput } from "@/server/modules/loyalty/program";

interface Drink {
  id: string;
  nameFr: string;
  nameEn: string;
}

type Bounds = { min: number; max: number };

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
const toCents = (text: string) => Math.round(Number(text.replace(",", ".").trim()) * 100);

/**
 * The owner's rule editor. Every save is a new version; the server refuses a submission that
 * changes nothing. Managers see the same form read-only.
 */
export function RulesForm({
  rules,
  drinks,
  canEdit,
}: {
  rules: LoyaltyRules;
  drinks: Drink[];
  canEdit: boolean;
}) {
  const t = useTranslations("AdminLoyalty");
  const locale = useLocale();
  const router = useRouter();
  const label = (d: Drink) => (locale === "fr" ? d.nameFr : d.nameEn);

  const [text, setText] = useState({
    stampsPerReward: String(rules.stampsPerReward),
    minPaid: dollars(rules.minPaidCentsPerDrink),
    maxPerPurchase: rules.maxStampsPerPurchase === null ? "" : String(rules.maxStampsPerPurchase),
    valueCap: dollars(rules.rewardValueCapCents),
    expiryDays: rules.rewardExpiryDays === null ? "" : String(rules.rewardExpiryDays),
    inStorePerVisit: String(rules.inStoreMaxStampsPerVisit),
    inStorePerDay: String(rules.inStoreMaxStampsPerDay),
    guestClaimDays: String(rules.guestClaimDays),
    referrerStamps: String(rules.referrerStamps),
    refereeStamps: String(rules.refereeStamps),
    referralMin: dollars(rules.referralMinOrderCents),
    referralCap: String(rules.referralMonthlyCap),
    note: "",
  });
  const [choices, setChoices] = useState({
    earnOn: rules.earnOn,
    rewardCoversModifiers: rules.rewardCoversModifiers,
    refundShortfallPolicy: rules.refundShortfallPolicy,
    rewardOnRefund: rules.rewardOnRefund,
    inStoreEnabled: rules.inStoreEnabled,
    referralEnabled: rules.referralEnabled,
  });
  const [excluded, setExcluded] = useState<string[]>([...rules.excludedProductIds]);
  const [rewardExcluded, setRewardExcluded] = useState<string[]>([
    ...rules.rewardExcludedProductIds,
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const setField = (key: keyof typeof text) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setText((v) => ({ ...v, [key]: value }));
  };

  const submit = async () => {
    const next: Record<string, string> = {};
    const whole = (key: keyof typeof text, b: Bounds, optional = false): number | null => {
      const raw = text[key].trim();
      if (optional && !raw) return null;
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < b.min || n > b.max)
        next[key] = t("errors.number", { min: b.min, max: b.max });
      return n;
    };
    const money = (key: keyof typeof text, b: Bounds, optional = false): number | null => {
      const raw = text[key].trim();
      if (optional && !raw) return null;
      const n = toCents(raw);
      if (!raw || !Number.isInteger(n) || n < b.min || n > b.max)
        next[key] = t("errors.number", { min: b.min / 100, max: b.max / 100 });
      return n;
    };
    const body: ProgramInput = {
      ...choices,
      stampsPerReward: whole("stampsPerReward", L.stampsPerReward) ?? 0,
      minPaidCentsPerDrink: money("minPaid", L.minPaidCentsPerDrink) ?? 0,
      maxStampsPerPurchase: whole("maxPerPurchase", L.maxStampsPerPurchase, true),
      rewardValueCapCents: money("valueCap", L.rewardValueCapCents, true),
      rewardExpiryDays: whole("expiryDays", L.rewardExpiryDays, true),
      inStoreMaxStampsPerVisit: whole("inStorePerVisit", L.inStoreMaxStampsPerVisit) ?? 0,
      inStoreMaxStampsPerDay: whole("inStorePerDay", L.inStoreMaxStampsPerDay) ?? 0,
      guestClaimDays: whole("guestClaimDays", L.guestClaimDays) ?? 0,
      referrerStamps: whole("referrerStamps", L.referrerStamps) ?? 0,
      refereeStamps: whole("refereeStamps", L.refereeStamps) ?? 0,
      referralMinOrderCents: money("referralMin", L.referralMinOrderCents) ?? 0,
      referralMonthlyCap: whole("referralCap", L.referralMonthlyCap) ?? 0,
      excludedProductIds: excluded,
      // Size-level exclusions have no editor yet; keep whatever is in force.
      excludedVariantIds: [...rules.excludedVariantIds],
      rewardExcludedProductIds: rewardExcluded,
      rewardExcludedVariantIds: [...rules.rewardExcludedVariantIds],
      note: text.note.trim(),
    };
    if (body.note.length < 3) next.note = t("errors.note");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setPending(true);
    setMessage(null);
    try {
      const saved = await apiFetch<{ version: number }>("/api/v1/admin/loyalty/programs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMessage({ ok: true, text: t("saved", { version: saved.version }) });
      setText((v) => ({ ...v, note: "" }));
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      setMessage({
        ok: false,
        text:
          f?.kind === "forbidden"
            ? t("errors.forbidden")
            : f?.kind === "unprocessable" && f.reason === "no_changes"
              ? t("errors.no_changes")
              : t("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  const drinkList = (selected: string[], set: (ids: string[]) => void) =>
    drinks.map((d) => (
      <CheckboxField
        key={d.id}
        label={label(d)}
        checked={selected.includes(d.id)}
        onChange={(e) => {
          const on = e.currentTarget.checked;
          set(on ? [...selected, d.id] : selected.filter((id) => id !== d.id));
        }}
      />
    ));

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* A disabled fieldset makes the whole form read-only for managers. */}
      <fieldset disabled={!canEdit || pending} className="flex flex-col gap-6">
        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("earning")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("stampsPerReward")}
              inputMode="numeric"
              value={text.stampsPerReward}
              error={errors.stampsPerReward}
              onChange={setField("stampsPerReward")}
            />
            <SelectField
              label={t("earnOn")}
              value={choices.earnOn}
              onChange={(e) => {
                const earnOn = EARN_TRIGGERS.find((v) => v === e.currentTarget.value);
                if (earnOn) setChoices((c) => ({ ...c, earnOn }));
              }}
            >
              {EARN_TRIGGERS.map((v) => (
                <option key={v} value={v}>
                  {t(`earnOnOptions.${v}`)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t("minPaid")}
              hint={t("minPaidHint")}
              inputMode="decimal"
              value={text.minPaid}
              error={errors.minPaid}
              onChange={setField("minPaid")}
            />
            <TextField
              label={t("maxPerPurchase")}
              hint={t("noLimitHint")}
              inputMode="numeric"
              value={text.maxPerPurchase}
              error={errors.maxPerPurchase}
              onChange={setField("maxPerPurchase")}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-semibold text-espresso">{t("excluded")}</legend>
            {drinkList(excluded, setExcluded)}
          </fieldset>
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("reward")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("valueCap")}
              hint={t("noLimitHint")}
              inputMode="decimal"
              value={text.valueCap}
              error={errors.valueCap}
              onChange={setField("valueCap")}
            />
            <TextField
              label={t("expiryDays")}
              hint={t("expiryHint")}
              inputMode="numeric"
              value={text.expiryDays}
              error={errors.expiryDays}
              onChange={setField("expiryDays")}
            />
          </div>
          <CheckboxField
            label={t("coversModifiers")}
            checked={choices.rewardCoversModifiers}
            onChange={(e) => {
              const rewardCoversModifiers = e.currentTarget.checked;
              setChoices((c) => ({ ...c, rewardCoversModifiers }));
            }}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-semibold text-espresso">{t("rewardExcluded")}</legend>
            {drinkList(rewardExcluded, setRewardExcluded)}
          </fieldset>
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("refunds")}</h2>
          <SelectField
            label={t("shortfall")}
            value={choices.refundShortfallPolicy}
            onChange={(e) => {
              const refundShortfallPolicy = REFUND_SHORTFALL_POLICIES.find(
                (v) => v === e.currentTarget.value,
              );
              if (refundShortfallPolicy) setChoices((c) => ({ ...c, refundShortfallPolicy }));
            }}
          >
            {REFUND_SHORTFALL_POLICIES.map((v) => (
              <option key={v} value={v}>
                {t(`shortfallOptions.${v}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("rewardOnRefund")}
            value={choices.rewardOnRefund}
            onChange={(e) => {
              const rewardOnRefund = REWARD_REFUND_POLICIES.find(
                (v) => v === e.currentTarget.value,
              );
              if (rewardOnRefund) setChoices((c) => ({ ...c, rewardOnRefund }));
            }}
          >
            {REWARD_REFUND_POLICIES.map((v) => (
              <option key={v} value={v}>
                {t(`rewardOnRefundOptions.${v}`)}
              </option>
            ))}
          </SelectField>
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("inStore")}</h2>
          <CheckboxField
            label={t("inStoreEnabled")}
            checked={choices.inStoreEnabled}
            onChange={(e) => {
              const inStoreEnabled = e.currentTarget.checked;
              setChoices((c) => ({ ...c, inStoreEnabled }));
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("inStorePerVisit")}
              inputMode="numeric"
              value={text.inStorePerVisit}
              error={errors.inStorePerVisit}
              onChange={setField("inStorePerVisit")}
            />
            <TextField
              label={t("inStorePerDay")}
              inputMode="numeric"
              value={text.inStorePerDay}
              error={errors.inStorePerDay}
              onChange={setField("inStorePerDay")}
            />
          </div>
          <TextField
            label={t("guestClaimDays")}
            hint={t("guestClaimHint")}
            inputMode="numeric"
            value={text.guestClaimDays}
            error={errors.guestClaimDays}
            onChange={setField("guestClaimDays")}
            className="sm:max-w-xs"
          />
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("referral")}</h2>
          <p className="text-sm text-espresso-muted">{t("referralHint")}</p>
          <CheckboxField
            label={t("referralEnabled")}
            checked={choices.referralEnabled}
            onChange={(e) => {
              const referralEnabled = e.currentTarget.checked;
              setChoices((c) => ({ ...c, referralEnabled }));
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("referrerStamps")}
              inputMode="numeric"
              value={text.referrerStamps}
              error={errors.referrerStamps}
              onChange={setField("referrerStamps")}
            />
            <TextField
              label={t("refereeStamps")}
              inputMode="numeric"
              value={text.refereeStamps}
              error={errors.refereeStamps}
              onChange={setField("refereeStamps")}
            />
            <TextField
              label={t("referralMin")}
              inputMode="decimal"
              value={text.referralMin}
              error={errors.referralMin}
              onChange={setField("referralMin")}
            />
            <TextField
              label={t("referralCap")}
              inputMode="numeric"
              value={text.referralCap}
              error={errors.referralCap}
              onChange={setField("referralCap")}
            />
          </div>
        </Surface>

        {canEdit ? (
          <Surface className="flex flex-col gap-4">
            <TextField
              label={t("note")}
              hint={t("noteHint")}
              maxLength={300}
              value={text.note}
              error={errors.note}
              onChange={setField("note")}
            />
            <Button type="submit" pending={pending} disabled={pending} className="self-start">
              {t("save")}
            </Button>
          </Surface>
        ) : null}
      </fieldset>
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </form>
  );
}
