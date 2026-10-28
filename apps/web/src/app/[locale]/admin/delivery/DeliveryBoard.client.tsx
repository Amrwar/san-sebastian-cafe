"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, CheckboxField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";
import type { AdminDeliveryZone, DeliveryZoneInput } from "@/server/modules/admin/delivery";

interface Draft {
  nameFr: string;
  nameEn: string;
  prefixes: string;
  fee: string;
  minimum: string;
  minutes: string;
  isActive: boolean;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
const cents = (text: string) => Math.round(Number(text.replace(",", ".").trim()) * 100);

function toDraft(z: AdminDeliveryZone | null): Draft {
  return {
    nameFr: z?.nameFr ?? "",
    nameEn: z?.nameEn ?? "",
    prefixes: z?.postalPrefixes.join(", ") ?? "",
    fee: z ? dollars(z.feeCents) : "",
    minimum: z && z.minimumOrderCents > 0 ? dollars(z.minimumOrderCents) : "",
    minutes: z ? String(z.estimatedMinutes) : "30",
    // A new zone starts switched off: it is checked before customers see it.
    isActive: z?.isActive ?? false,
  };
}

/** Delivery zones: list, create, edit, switch on or off. */
export function DeliveryBoard({ zones }: { zones: AdminDeliveryZone[] }) {
  const t = useTranslations("AdminDelivery");
  const tMenu = useTranslations("AdminMenu");
  const locale = useLocale();
  const router = useRouter();
  const label = (z: AdminDeliveryZone) => (locale === "fr" ? z.nameFr : z.nameEn);
  /** "new", a zone id, or null when no form is open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const open = (z: AdminDeliveryZone | null) => {
    setEditing(z?.id ?? "new");
    setDraft(toDraft(z));
    setMessage(null);
  };

  const save = async () => {
    const body: DeliveryZoneInput = {
      nameFr: draft.nameFr,
      nameEn: draft.nameEn,
      postalPrefixes: draft.prefixes
        .split(/[\s,;]+/)
        .map((p) => p.trim())
        .filter(Boolean),
      feeCents: draft.fee.trim() ? cents(draft.fee) : 0,
      minimumOrderCents: draft.minimum.trim() ? cents(draft.minimum) : 0,
      estimatedMinutes: Number(draft.minutes.trim()),
      isActive: draft.isActive,
    };
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(
        editing === "new"
          ? "/api/v1/admin/delivery-zones"
          : `/api/v1/admin/delivery-zones/${editing}`,
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
          f?.kind === "conflict" && f.reason === "prefix_taken"
            ? t("errors.prefixTaken")
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

  const form = (
    <form
      noValidate
      className="flex flex-col gap-4 rounded-sm border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
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
      <TextField
        label={t("prefixes")}
        hint={t("prefixesHint")}
        value={draft.prefixes}
        autoCapitalize="characters"
        onChange={(e) => {
          set({ prefixes: e.currentTarget.value.toUpperCase() });
        }}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label={t("fee")}
          inputMode="decimal"
          value={draft.fee}
          onChange={(e) => {
            set({ fee: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("minimum")}
          optionalLabel={t("optional")}
          inputMode="decimal"
          value={draft.minimum}
          onChange={(e) => {
            set({ minimum: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("minutes")}
          hint={t("minutesHint")}
          inputMode="numeric"
          value={draft.minutes}
          onChange={(e) => {
            set({ minutes: e.currentTarget.value });
          }}
        />
      </div>
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
      {zones.length === 0 ? <p className="text-espresso-muted">{t("empty")}</p> : null}
      <ul className="flex flex-col gap-3">
        {zones.map((z) => (
          <li key={z.id}>
            <Surface className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-espresso">{label(z)}</h2>
                <Badge tone={z.isActive ? "success" : "neutral"}>
                  {z.isActive ? t("on") : t("off")}
                </Badge>
                {z.isDemo ? <Badge tone="warning">{t("demo")}</Badge> : null}
              </div>
              <p className="text-sm">
                {z.postalPrefixes.map((p) => (
                  <code
                    key={p}
                    className="me-1 rounded-sm bg-ivory-sunken px-1.5 py-0.5 font-semibold"
                  >
                    {p}
                  </code>
                ))}
              </p>
              <p className="text-sm text-espresso-muted">
                {t("summary", {
                  fee: money(z.feeCents, locale),
                  minutes: z.estimatedMinutes,
                })}
                {z.minimumOrderCents > 0
                  ? ` · ${t("minimumShort", { amount: money(z.minimumOrderCents, locale) })}`
                  : ""}
                {" · "}
                {t("orders", { count: z.orders })}
              </p>
              {editing === z.id ? (
                form
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  aria-label={`${t("edit")} ${label(z)}`}
                  onClick={() => {
                    open(z);
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
