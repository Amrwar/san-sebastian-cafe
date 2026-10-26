"use client";

import { useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, CheckboxField, SelectField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";
import type { AdminPromotion, PromotionInput } from "@/server/modules/admin/promotions";

interface Named {
  id: string;
  nameFr: string;
  nameEn: string;
}

interface Draft {
  code: string;
  nameFr: string;
  nameEn: string;
  kind: "percent_off" | "amount_off";
  value: string;
  scope: "order" | "product" | "category";
  targetIds: string[];
  minSubtotal: string;
  startsOn: string;
  endsOn: string;
  maxRedemptions: string;
  maxPerCustomer: string;
  stackableWithRewards: boolean;
  isActive: boolean;
}

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
const dollars = (cents: number) => (cents / 100).toFixed(2);

function toDraft(p: AdminPromotion | null): Draft {
  return {
    code: p?.code ?? "",
    nameFr: p?.nameFr ?? "",
    nameEn: p?.nameEn ?? "",
    kind: p?.kind ?? "percent_off",
    value: p ? (p.kind === "percent_off" ? String(p.value / 100) : dollars(p.value)) : "",
    scope: p?.scope ?? "order",
    targetIds: p?.targetIds ?? [],
    minSubtotal: p && p.minSubtotalCents > 0 ? dollars(p.minSubtotalCents) : "",
    startsOn: p?.startsOn ?? today(),
    endsOn: p?.endsOn ?? "",
    maxRedemptions: p?.maxRedemptions ? String(p.maxRedemptions) : "",
    maxPerCustomer: p?.maxRedemptionsPerCustomer ? String(p.maxRedemptionsPerCustomer) : "",
    stackableWithRewards: p?.stackableWithRewards ?? false,
    isActive: p?.isActive ?? true,
  };
}

const cents = (text: string) => Math.round(Number(text.replace(",", ".").trim()) * 100);
const count = (text: string) => (text.trim() === "" ? null : Number(text.trim()));

export function PromotionBoard({
  promotions,
  categories,
  products,
}: {
  promotions: AdminPromotion[];
  categories: Named[];
  products: Named[];
}) {
  const t = useTranslations("AdminPromotions");
  const tMenu = useTranslations("AdminMenu");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const label = (o: Named) => (locale === "fr" ? o.nameFr : o.nameEn);
  /** "new", a promotion id, or null when no form is open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const valueText = (p: AdminPromotion) =>
    p.kind === "percent_off"
      ? t("percentOff", { percent: format.number(p.value / 100) })
      : t("amountOff", { amount: money(p.value, locale) });

  const open = (p: AdminPromotion | null) => {
    setEditing(p?.id ?? "new");
    setDraft(toDraft(p));
    setMessage(null);
  };

  const save = async () => {
    const body: PromotionInput = {
      code: draft.code,
      nameFr: draft.nameFr,
      nameEn: draft.nameEn,
      kind: draft.kind,
      value:
        draft.kind === "percent_off"
          ? Math.round(Number(draft.value.replace(",", ".")) * 100)
          : cents(draft.value),
      scope: draft.scope,
      targetIds: draft.scope === "order" ? [] : draft.targetIds,
      minSubtotalCents: draft.minSubtotal.trim() ? cents(draft.minSubtotal) : 0,
      startsOn: draft.startsOn,
      endsOn: draft.endsOn || null,
      maxRedemptions: count(draft.maxRedemptions),
      maxRedemptionsPerCustomer: count(draft.maxPerCustomer),
      stackableWithRewards: draft.stackableWithRewards,
      isActive: draft.isActive,
    };
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(
        editing === "new" ? "/api/v1/admin/promotions" : `/api/v1/admin/promotions/${editing}`,
        { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(body) },
      );
      setEditing(null);
      setMessage({ ok: true, text: t("saved") });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      setMessage({
        ok: false,
        text:
          f?.kind === "conflict" && f.reason === "code_taken"
            ? t("errors.codeTaken")
            : f?.kind === "validation"
              ? t("errors.fields")
              : f?.kind === "forbidden"
                ? tMenu("errors.forbidden")
                : tMenu("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  const targets = draft.scope === "product" ? products : categories;
  const form = (
    <form
      noValidate
      className="flex flex-col gap-4 rounded-sm border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label={t("code")}
          hint={t("codeHint")}
          value={draft.code}
          maxLength={32}
          autoCapitalize="characters"
          onChange={(e) => {
            set({ code: e.currentTarget.value.toUpperCase() });
          }}
        />
        <TextField
          label={t("nameFr")}
          lang="fr"
          value={draft.nameFr}
          maxLength={80}
          onChange={(e) => {
            set({ nameFr: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("nameEn")}
          lang="en"
          value={draft.nameEn}
          maxLength={80}
          onChange={(e) => {
            set({ nameEn: e.currentTarget.value });
          }}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label={t("kind")}
          value={draft.kind}
          onChange={(e) => {
            set({ kind: e.currentTarget.value as Draft["kind"] });
          }}
        >
          <option value="percent_off">{t("kinds.percent_off")}</option>
          <option value="amount_off">{t("kinds.amount_off")}</option>
        </SelectField>
        <TextField
          label={draft.kind === "percent_off" ? t("percent") : t("amount")}
          inputMode="decimal"
          value={draft.value}
          onChange={(e) => {
            set({ value: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("minSubtotal")}
          optionalLabel={t("optional")}
          inputMode="decimal"
          value={draft.minSubtotal}
          onChange={(e) => {
            set({ minSubtotal: e.currentTarget.value });
          }}
        />
      </div>
      <SelectField
        label={t("scope")}
        value={draft.scope}
        onChange={(e) => {
          set({ scope: e.currentTarget.value as Draft["scope"], targetIds: [] });
        }}
      >
        <option value="order">{t("scopes.order")}</option>
        <option value="category">{t("scopes.category")}</option>
        <option value="product">{t("scopes.product")}</option>
      </SelectField>
      {draft.scope !== "order" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-espresso">
            {draft.scope === "product" ? t("chooseProducts") : t("chooseCategories")}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {targets.map((target) => (
              <CheckboxField
                key={target.id}
                label={label(target)}
                checked={draft.targetIds.includes(target.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  set({
                    targetIds: on
                      ? [...draft.targetIds, target.id]
                      : draft.targetIds.filter((id) => id !== target.id),
                  });
                }}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("startsOn")}
          type="date"
          value={draft.startsOn}
          onChange={(e) => {
            set({ startsOn: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("endsOn")}
          optionalLabel={t("optional")}
          type="date"
          value={draft.endsOn}
          onChange={(e) => {
            set({ endsOn: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("maxRedemptions")}
          optionalLabel={t("optional")}
          inputMode="numeric"
          value={draft.maxRedemptions}
          onChange={(e) => {
            set({ maxRedemptions: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("maxPerCustomer")}
          optionalLabel={t("optional")}
          inputMode="numeric"
          value={draft.maxPerCustomer}
          onChange={(e) => {
            set({ maxPerCustomer: e.currentTarget.value });
          }}
        />
      </div>
      <CheckboxField
        label={t("stackable")}
        hint={t("stackableHint")}
        checked={draft.stackableWithRewards}
        onChange={(e) => {
          set({ stackableWithRewards: e.currentTarget.checked });
        }}
      />
      <CheckboxField
        label={t("active")}
        hint={t("activeHint")}
        checked={draft.isActive}
        onChange={(e) => {
          set({ isActive: e.currentTarget.checked });
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" pending={pending} disabled={pending}>
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setEditing(null);
          }}
        >
          {tMenu("cancel")}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-4">
      {editing === "new" ? (
        form
      ) : (
        <Button
          type="button"
          className="self-start"
          onClick={() => {
            open(null);
          }}
        >
          {t("new")}
        </Button>
      )}
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
      {promotions.length === 0 ? <p className="text-espresso-muted">{t("empty")}</p> : null}
      <ul className="flex flex-col gap-3">
        {promotions.map((p) => (
          <li key={p.id}>
            <Surface className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-espresso">{label(p)}</h2>
                <Badge
                  tone={
                    p.state === "active" ? "success" : p.state === "scheduled" ? "brand" : "neutral"
                  }
                >
                  {t(`states.${p.state}`)}
                </Badge>
                {p.isDemo ? <Badge tone="warning">{t("demo")}</Badge> : null}
              </div>
              <p className="text-sm">
                <code className="rounded-sm bg-ivory-sunken px-1.5 py-0.5 font-semibold">
                  {p.code}
                </code>{" "}
                · {valueText(p)} ·{" "}
                {p.scope === "order"
                  ? t("scopes.order")
                  : t("scopeCount", { scope: p.scope, count: p.targetIds.length })}
                {p.minSubtotalCents > 0
                  ? ` · ${t("minimum", { amount: money(p.minSubtotalCents, locale) })}`
                  : ""}
              </p>
              <p className="text-sm text-espresso-muted">
                {p.endsOn
                  ? t("window", { from: day(p.startsOn), to: day(p.endsOn) })
                  : t("windowOpen", { from: day(p.startsOn) })}
                {" · "}
                {t("usage", { count: p.uses, amount: money(p.discountGivenCents, locale) })}
                {p.maxRedemptions ? ` · ${t("limit", { count: p.maxRedemptions })}` : ""}
              </p>
              {editing === p.id ? (
                form
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  aria-label={`${t("edit")} ${label(p)}`}
                  onClick={() => {
                    open(p);
                  }}
                >
                  {t("edit")}
                </Button>
              )}
            </Surface>
          </li>
        ))}
      </ul>
    </div>
  );
}
