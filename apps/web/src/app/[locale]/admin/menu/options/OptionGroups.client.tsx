"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, CheckboxField, SelectField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";
import type { AdminModifierGroup, ModifierGroupInput } from "@/server/modules/admin/menu";

function useErrorText() {
  const t = useTranslations("AdminMenu");
  return (error: unknown) => {
    if (error instanceof ApiError) {
      const f = error.failure;
      if (f.kind === "forbidden") return t("errors.forbidden");
      if (f.kind === "validation") return t("errors.validation");
      if ("reason" in f && f.reason && t.has(`errors.${f.reason}`))
        return t(`errors.${f.reason}` as "errors.generic");
    }
    return t("errors.generic");
  };
}

export function OptionGroups({ groups }: { groups: AdminModifierGroup[] }) {
  const t = useTranslations("AdminOptions");
  const tMenu = useTranslations("AdminMenu");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const errorText = useErrorText();
  const [editing, setEditing] = useState<string | null>(null); // a group id, or "new"
  const [archiving, setArchiving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const label = (o: { nameFr: string; nameEn: string }) => (locale === "fr" ? o.nameFr : o.nameEn);
  const done = () => {
    setEditing(null);
    router.refresh();
  };

  const archive = async (id: string) => {
    setArchiving(null);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/admin/modifier-groups/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite">{message ? <Alert tone="danger">{message}</Alert> : null}</div>
      {editing === "new" ? (
        <Surface>
          <GroupForm onDone={done} />
        </Surface>
      ) : (
        <Button
          className="self-start"
          onClick={() => {
            setEditing("new");
          }}
        >
          {t("newGroup")}
        </Button>
      )}

      {groups.map((g) => {
        const name = label(g);
        return (
          <Surface key={g.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="flex flex-wrap items-center gap-2 font-display text-2xl text-espresso">
                  {name}
                  {g.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                </h2>
                <p className="text-sm text-espresso-muted">
                  {t("summary", {
                    count: g.options.length,
                    rule:
                      g.selection === "single"
                        ? t("ruleSingle")
                        : t("ruleRange", { min: g.minSelected, max: g.maxSelected }),
                  })}
                  {" · "}
                  {t("usedBy", { count: g.usedBy })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={editing === g.id}
                  onClick={() => {
                    setEditing(editing === g.id ? null : g.id);
                  }}
                >
                  {t("edit")}
                </Button>
                {archiving === g.id ? (
                  <span
                    role="group"
                    aria-label={tMenu("archive")}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="text-sm">{tMenu("archiveConfirm", { name })}</span>
                    <Button size="sm" variant="danger" onClick={() => void archive(g.id)}>
                      {tMenu("confirm")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setArchiving(null);
                      }}
                    >
                      {tMenu("cancel")}
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setArchiving(g.id);
                    }}
                  >
                    {tMenu("archive")}
                  </Button>
                )}
              </div>
            </div>
            {editing === g.id ? (
              <GroupForm group={g} onDone={done} />
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm text-espresso-muted">
                {g.options.map((o) => (
                  <li key={o.id} className="rounded-pill border border-line px-3 py-1">
                    {label(o)}
                    {o.priceDeltaCents !== 0 ? ` · ${money(o.priceDeltaCents, locale)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        );
      })}
    </div>
  );
}

interface OptionRow {
  key: number;
  id?: string;
  nameFr: string;
  nameEn: string;
  price: string;
  isDefault: boolean;
}

function GroupForm({ group, onDone }: { group?: AdminModifierGroup; onDone: () => void }) {
  const t = useTranslations("AdminOptions");
  const tMenu = useTranslations("AdminMenu");
  const errorText = useErrorText();
  const [fields, setFields] = useState({
    nameFr: group?.nameFr ?? "",
    nameEn: group?.nameEn ?? "",
    selection: group?.selection ?? "single",
    minSelected: String(group?.minSelected ?? 0),
    maxSelected: String(group?.maxSelected ?? 1),
  });
  const [options, setOptions] = useState<OptionRow[]>(
    group
      ? group.options.map((o, key) => ({
          key,
          id: o.id,
          nameFr: o.nameFr,
          nameEn: o.nameEn,
          price: (o.priceDeltaCents / 100).toFixed(2),
          isDefault: o.isDefault,
        }))
      : [{ key: 0, nameFr: "", nameEn: "", price: "0.00", isDefault: false }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const min = Number(fields.minSelected);
    const max = fields.selection === "single" ? 1 : Number(fields.maxSelected);
    const next: Record<string, string> = {};
    if (!fields.nameFr.trim()) next.nameFr = tMenu("errors.required");
    if (!fields.nameEn.trim()) next.nameEn = tMenu("errors.required");
    for (const o of options) {
      if (!o.nameFr.trim()) next[`o-${o.key}-fr`] = tMenu("errors.required");
      if (!o.nameEn.trim()) next[`o-${o.key}-en`] = tMenu("errors.required");
      const cents = Math.round(Number(o.price.replace(",", ".")) * 100);
      if (!Number.isInteger(cents) || Math.abs(cents) > 10_000)
        next[`o-${o.key}-price`] = t("errors.price");
    }
    const defaults = options.filter((o) => o.isDefault).length;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      min > max ||
      max > options.length ||
      defaults > max
    )
      next.rules = t("errors.rules");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: ModifierGroupInput = {
      nameFr: fields.nameFr.trim(),
      nameEn: fields.nameEn.trim(),
      selection: fields.selection,
      minSelected: min,
      maxSelected: max,
      options: options.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        nameFr: o.nameFr.trim(),
        nameEn: o.nameEn.trim(),
        priceDeltaCents: Math.round(Number(o.price.replace(",", ".")) * 100),
        isDefault: o.isDefault,
      })),
    };
    setPending(true);
    setError(null);
    try {
      await apiFetch(
        group ? `/api/v1/admin/modifier-groups/${group.id}` : "/api/v1/admin/modifier-groups",
        { method: group ? "PUT" : "POST", body: JSON.stringify(body) },
      );
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  const update = (key: number, patch: Partial<OptionRow>) => {
    setOptions((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("nameFr")}
          lang="fr"
          value={fields.nameFr}
          maxLength={60}
          error={errors.nameFr}
          onChange={(e) => {
            const nameFr = e.currentTarget.value;
            setFields((f) => ({ ...f, nameFr }));
          }}
        />
        <TextField
          label={t("nameEn")}
          lang="en"
          value={fields.nameEn}
          maxLength={60}
          error={errors.nameEn}
          onChange={(e) => {
            const nameEn = e.currentTarget.value;
            setFields((f) => ({ ...f, nameEn }));
          }}
        />
        <SelectField
          label={t("selection")}
          value={fields.selection}
          onChange={(e) => {
            const selection = e.currentTarget.value === "multiple" ? "multiple" : "single";
            setFields((f) => ({
              ...f,
              selection,
              ...(selection === "single" ? { maxSelected: "1" } : {}),
            }));
          }}
        >
          <option value="single">{t("single")}</option>
          <option value="multiple">{t("multiple")}</option>
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t("min")}
            inputMode="numeric"
            value={fields.minSelected}
            onChange={(e) => {
              const minSelected = e.currentTarget.value;
              setFields((f) => ({ ...f, minSelected }));
            }}
          />
          <TextField
            label={t("max")}
            inputMode="numeric"
            value={fields.selection === "single" ? "1" : fields.maxSelected}
            disabled={fields.selection === "single"}
            onChange={(e) => {
              const maxSelected = e.currentTarget.value;
              setFields((f) => ({ ...f, maxSelected }));
            }}
          />
        </div>
      </div>
      {errors.rules ? <Alert tone="danger">{errors.rules}</Alert> : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold text-espresso">{t("options")}</legend>
        {options.map((o, index) => (
          <div
            key={o.key}
            role="group"
            aria-label={`${t("options")} ${index + 1}`}
            className="grid items-end gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_1fr_8rem_auto]"
          >
            <TextField
              label={t("optionNameFr")}
              lang="fr"
              value={o.nameFr}
              maxLength={60}
              error={errors[`o-${o.key}-fr`]}
              onChange={(e) => {
                update(o.key, { nameFr: e.currentTarget.value });
              }}
            />
            <TextField
              label={t("optionNameEn")}
              lang="en"
              value={o.nameEn}
              maxLength={60}
              error={errors[`o-${o.key}-en`]}
              onChange={(e) => {
                update(o.key, { nameEn: e.currentTarget.value });
              }}
            />
            <TextField
              label={t("optionPrice")}
              inputMode="decimal"
              value={o.price}
              error={errors[`o-${o.key}-price`]}
              onChange={(e) => {
                update(o.key, { price: e.currentTarget.value });
              }}
            />
            <div className="flex flex-wrap items-center gap-2 pb-1">
              <CheckboxField
                label={t("optionDefault")}
                checked={o.isDefault}
                onChange={(e) => {
                  const isDefault = e.currentTarget.checked;
                  setOptions((rows) =>
                    rows.map((r) =>
                      r.key === o.key
                        ? { ...r, isDefault }
                        : fields.selection === "single" && isDefault
                          ? { ...r, isDefault: false }
                          : r,
                    ),
                  );
                }}
              />
              {options.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`${t("removeOption")} ${index + 1}`}
                  onClick={() => {
                    setOptions((rows) => rows.filter((r) => r.key !== o.key));
                  }}
                >
                  {t("removeOption")}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {options.length < 30 ? (
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            onClick={() => {
              setOptions((rows) => [
                ...rows,
                {
                  key: (rows.at(-1)?.key ?? 0) + 1,
                  nameFr: "",
                  nameEn: "",
                  price: "0.00",
                  isDefault: false,
                },
              ]);
            }}
          >
            {t("addOption")}
          </Button>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending} disabled={pending}>
          {t("save")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tMenu("cancel")}
        </Button>
      </div>
      <div aria-live="polite">{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    </form>
  );
}
