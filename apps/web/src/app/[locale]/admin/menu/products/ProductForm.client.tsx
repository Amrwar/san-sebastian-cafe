"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AVAILABILITY, TAX_CATEGORIES } from "@ssc/domain";
import { Alert, Button, CheckboxField, SelectField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { AdminModifierGroup, AdminProduct, ProductInput } from "@/server/modules/admin/menu";

interface SizeRow {
  key: number;
  id?: string;
  nameFr: string;
  nameEn: string;
  price: string;
  isDefault: boolean;
}

interface WindowRow {
  key: number;
  weekday: number;
  from: string;
  to: string;
}

type Fields = Omit<ProductInput, "variants" | "windows" | "modifierGroupIds"> & {
  descriptionFr: string;
  descriptionEn: string;
  allergenNoteFr: string;
  allergenNoteEn: string;
};

const toTime = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const toMinute = (time: string, end = false) => {
  const [h, m] = time.split(":").map(Number);
  const minute = (h ?? 0) * 60 + (m ?? 0);
  // "00:00" as an end time means midnight at the end of the day.
  return end && minute === 0 ? 1440 : minute;
};
const toCents = (text: string) => Math.round(Number(text.replace(",", ".").trim()) * 100);

export function ProductForm({
  product,
  categories,
  groups,
  defaultCategoryId,
}: {
  product: AdminProduct | null;
  categories: Array<{ id: string; nameFr: string; nameEn: string }>;
  groups: AdminModifierGroup[];
  defaultCategoryId: string;
}) {
  const t = useTranslations("AdminProduct");
  const tMenu = useTranslations("AdminMenu");
  const locale = useLocale();
  const router = useRouter();
  const label = (o: { nameFr: string; nameEn: string }) => (locale === "fr" ? o.nameFr : o.nameEn);

  const [fields, setFields] = useState<Fields>({
    categoryId: product?.categoryId ?? defaultCategoryId,
    nameFr: product?.nameFr ?? "",
    nameEn: product?.nameEn ?? "",
    descriptionFr: product?.descriptionFr ?? "",
    descriptionEn: product?.descriptionEn ?? "",
    allergenNoteFr: product?.allergenNoteFr ?? "",
    allergenNoteEn: product?.allergenNoteEn ?? "",
    taxCategory: product?.taxCategory ?? "standard",
    isDrink: product?.isDrink ?? true,
    isFeatured: product?.isFeatured ?? false,
    loyaltyQualifying: product?.loyaltyQualifying ?? true,
    rewardEligible: product?.rewardEligible ?? true,
    availability: product?.availability ?? "available",
  });
  const [sizes, setSizes] = useState<SizeRow[]>(
    product
      ? product.variants.map((v, key) => ({
          key,
          id: v.id,
          nameFr: v.nameFr,
          nameEn: v.nameEn,
          price: (v.priceCents / 100).toFixed(2),
          isDefault: v.isDefault,
        }))
      : [{ key: 0, nameFr: "", nameEn: "", price: "", isDefault: true }],
  );
  const [groupIds, setGroupIds] = useState<string[]>(product?.modifierGroupIds ?? []);
  const [windows, setWindows] = useState<WindowRow[]>(
    (product?.windows ?? []).map((w, key) => ({
      key,
      weekday: w.weekday,
      from: toTime(w.startMinute),
      to: toTime(w.endMinute),
    })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
  };
  const nextKey = (rows: Array<{ key: number }>) => (rows.at(-1)?.key ?? 0) + 1;

  const validate = () => {
    const next: Record<string, string> = {};
    if (!fields.nameFr.trim()) next.nameFr = tMenu("errors.required");
    if (!fields.nameEn.trim()) next.nameEn = tMenu("errors.required");
    for (const s of sizes) {
      if (!s.nameFr.trim()) next[`size-${s.key}-fr`] = tMenu("errors.required");
      if (!s.nameEn.trim()) next[`size-${s.key}-en`] = tMenu("errors.required");
      const cents = toCents(s.price);
      if (!Number.isInteger(cents) || cents < 0 || cents > 100_000 || !s.price.trim())
        next[`size-${s.key}-price`] = t("errors.price");
    }
    if (sizes.filter((s) => s.isDefault).length !== 1) next.sizes = t("errors.defaultSize");
    for (const w of windows) {
      if (!(toMinute(w.from) < toMinute(w.to, true))) next[`window-${w.key}`] = t("errors.window");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) {
      setMessage({ ok: false, text: tMenu("errors.validation") });
      return;
    }
    const body: ProductInput = {
      ...fields,
      variants: sizes.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        nameFr: s.nameFr.trim(),
        nameEn: s.nameEn.trim(),
        priceCents: toCents(s.price),
        isDefault: s.isDefault,
      })),
      modifierGroupIds: groupIds,
      windows: windows.map((w) => ({
        weekday: w.weekday,
        startMinute: toMinute(w.from),
        endMinute: toMinute(w.to, true),
      })),
    };
    setPending(true);
    setMessage(null);
    try {
      const saved = await apiFetch<{ id: string }>(
        product ? `/api/v1/admin/products/${product.id}` : "/api/v1/admin/products",
        { method: product ? "PUT" : "POST", body: JSON.stringify(body) },
      );
      if (product) {
        setMessage({ ok: true, text: t("saved") });
        router.refresh();
      } else {
        router.replace(`/admin/menu/products/${saved.id}?created=1`);
      }
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      setMessage({
        ok: false,
        text:
          f?.kind === "forbidden"
            ? tMenu("errors.forbidden")
            : f?.kind === "validation"
              ? tMenu("errors.validation")
              : tMenu("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  const optional = t("optional");
  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Surface className="flex flex-col gap-4">
        <h2 className="font-display text-2xl text-espresso">{t("basics")}</h2>
        <SelectField
          label={t("category")}
          value={fields.categoryId}
          onChange={(e) => {
            set({ categoryId: e.currentTarget.value });
          }}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("nameFr")}
            lang="fr"
            value={fields.nameFr}
            maxLength={80}
            error={errors.nameFr}
            onChange={(e) => {
              set({ nameFr: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("nameEn")}
            lang="en"
            value={fields.nameEn}
            maxLength={80}
            error={errors.nameEn}
            onChange={(e) => {
              set({ nameEn: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("descriptionFr")}
            optionalLabel={optional}
            lang="fr"
            value={fields.descriptionFr}
            maxLength={500}
            onChange={(e) => {
              set({ descriptionFr: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("descriptionEn")}
            optionalLabel={optional}
            lang="en"
            value={fields.descriptionEn}
            maxLength={500}
            onChange={(e) => {
              set({ descriptionEn: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("allergenFr")}
            optionalLabel={optional}
            hint={t("allergenHint")}
            lang="fr"
            value={fields.allergenNoteFr}
            maxLength={500}
            onChange={(e) => {
              set({ allergenNoteFr: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("allergenEn")}
            optionalLabel={optional}
            hint={t("allergenHint")}
            lang="en"
            value={fields.allergenNoteEn}
            maxLength={500}
            onChange={(e) => {
              set({ allergenNoteEn: e.currentTarget.value });
            }}
          />
        </div>
      </Surface>

      <Surface className="flex flex-col gap-4">
        <h2 className="font-display text-2xl text-espresso">{t("settings")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t("availability")}
            value={fields.availability}
            onChange={(e) => {
              const value = AVAILABILITY.find((a) => a === e.currentTarget.value);
              if (value) set({ availability: value });
            }}
          >
            {AVAILABILITY.map((a) => (
              <option key={a} value={a}>
                {tMenu(`availability.${a}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("taxCategory")}
            hint={t("taxHint")}
            value={fields.taxCategory}
            onChange={(e) => {
              const value = TAX_CATEGORIES.find((c) => c === e.currentTarget.value);
              if (value) set({ taxCategory: value });
            }}
          >
            {TAX_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`taxCategories.${c}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <CheckboxField
          label={t("isDrink")}
          checked={fields.isDrink}
          onChange={(e) => {
            const isDrink = e.currentTarget.checked;
            set(
              isDrink ? { isDrink } : { isDrink, loyaltyQualifying: false, rewardEligible: false },
            );
          }}
        />
        <CheckboxField
          label={t("loyaltyQualifying")}
          hint={fields.isDrink ? undefined : t("drinksOnly")}
          disabled={!fields.isDrink}
          checked={fields.loyaltyQualifying}
          onChange={(e) => {
            set({ loyaltyQualifying: e.currentTarget.checked });
          }}
        />
        <CheckboxField
          label={t("rewardEligible")}
          hint={fields.isDrink ? undefined : t("drinksOnly")}
          disabled={!fields.isDrink}
          checked={fields.rewardEligible}
          onChange={(e) => {
            set({ rewardEligible: e.currentTarget.checked });
          }}
        />
        <CheckboxField
          label={t("isFeatured")}
          checked={fields.isFeatured}
          onChange={(e) => {
            set({ isFeatured: e.currentTarget.checked });
          }}
        />
      </Surface>

      <Surface className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="font-display text-2xl text-espresso">{t("sizes")}</legend>
          <p className="text-sm text-espresso-muted">{t("sizesHint")}</p>
          {errors.sizes ? <Alert tone="danger">{errors.sizes}</Alert> : null}
          {sizes.map((s, index) => (
            <div
              key={s.key}
              role="group"
              aria-label={`${t("sizes")} ${index + 1}`}
              className="grid items-end gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_1fr_9rem_auto]"
            >
              <TextField
                label={t("sizeNameFr")}
                lang="fr"
                value={s.nameFr}
                maxLength={40}
                error={errors[`size-${s.key}-fr`]}
                onChange={(e) => {
                  const nameFr = e.currentTarget.value;
                  setSizes((rows) => rows.map((r) => (r.key === s.key ? { ...r, nameFr } : r)));
                }}
              />
              <TextField
                label={t("sizeNameEn")}
                lang="en"
                value={s.nameEn}
                maxLength={40}
                error={errors[`size-${s.key}-en`]}
                onChange={(e) => {
                  const nameEn = e.currentTarget.value;
                  setSizes((rows) => rows.map((r) => (r.key === s.key ? { ...r, nameEn } : r)));
                }}
              />
              <TextField
                label={t("sizePrice")}
                inputMode="decimal"
                value={s.price}
                error={errors[`size-${s.key}-price`]}
                onChange={(e) => {
                  const price = e.currentTarget.value;
                  setSizes((rows) => rows.map((r) => (r.key === s.key ? { ...r, price } : r)));
                }}
              />
              <div className="flex flex-wrap items-center gap-2 pb-1">
                <label className="inline-flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="default-size"
                    className="size-5 accent-burgundy"
                    checked={s.isDefault}
                    onChange={() => {
                      setSizes((rows) => rows.map((r) => ({ ...r, isDefault: r.key === s.key })));
                    }}
                  />
                  {t("sizeDefault")}
                </label>
                {sizes.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("removeSize")} ${index + 1}`}
                    onClick={() => {
                      setSizes((rows) => {
                        const rest = rows.filter((r) => r.key !== s.key);
                        return s.isDefault && rest[0]
                          ? rest.map((r, i) => ({ ...r, isDefault: i === 0 }))
                          : rest;
                      });
                    }}
                  >
                    {t("removeSize")}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {sizes.length < 8 ? (
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              onClick={() => {
                setSizes((rows) => [
                  ...rows,
                  { key: nextKey(rows), nameFr: "", nameEn: "", price: "", isDefault: false },
                ]);
              }}
            >
              {t("addSize")}
            </Button>
          ) : null}
        </fieldset>
      </Surface>

      <Surface className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="font-display text-2xl text-espresso">{t("groups")}</legend>
          <p className="text-sm text-espresso-muted">{t("groupsHint")}</p>
          {groups.length === 0 ? <p className="text-espresso-muted">{t("noGroups")}</p> : null}
          {[
            ...groupIds.flatMap((id) => groups.filter((g) => g.id === id)),
            ...groups.filter((g) => !groupIds.includes(g.id)),
          ].map((g) => {
            const index = groupIds.indexOf(g.id);
            const name = label(g);
            return (
              <div key={g.id} className="flex flex-wrap items-center justify-between gap-2">
                <CheckboxField
                  label={name}
                  checked={index >= 0}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setGroupIds((ids) => (on ? [...ids, g.id] : ids.filter((id) => id !== g.id)));
                  }}
                />
                {index >= 0 ? (
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={tMenu("moveUp", { name })}
                      disabled={index === 0}
                      onClick={() => {
                        setGroupIds((ids) => swap(ids, index, index - 1));
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={tMenu("moveDown", { name })}
                      disabled={index === groupIds.length - 1}
                      onClick={() => {
                        setGroupIds((ids) => swap(ids, index, index + 1));
                      }}
                    >
                      ↓
                    </Button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      </Surface>

      <Surface className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="font-display text-2xl text-espresso">{t("schedule")}</legend>
          <p className="text-sm text-espresso-muted">{t("scheduleHint")}</p>
          {windows.map((w, index) => (
            <div
              key={w.key}
              role="group"
              aria-label={`${t("schedule")} ${index + 1}`}
              className="flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
            >
              <SelectField
                label={t("weekday")}
                value={String(w.weekday)}
                onChange={(e) => {
                  const weekday = Number(e.currentTarget.value);
                  setWindows((rows) => rows.map((r) => (r.key === w.key ? { ...r, weekday } : r)));
                }}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>
                    {t(`weekdays.${String(d) as "0"}`)}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={t("from")}
                type="time"
                value={w.from}
                onChange={(e) => {
                  const from = e.currentTarget.value;
                  setWindows((rows) => rows.map((r) => (r.key === w.key ? { ...r, from } : r)));
                }}
              />
              <TextField
                label={t("to")}
                type="time"
                value={w.to}
                error={errors[`window-${w.key}`]}
                onChange={(e) => {
                  const to = e.currentTarget.value;
                  setWindows((rows) => rows.map((r) => (r.key === w.key ? { ...r, to } : r)));
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`${t("removeWindow")} ${index + 1}`}
                onClick={() => {
                  setWindows((rows) => rows.filter((r) => r.key !== w.key));
                }}
              >
                {t("removeWindow")}
              </Button>
            </div>
          ))}
          {windows.length < 21 ? (
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              onClick={() => {
                setWindows((rows) => [
                  ...rows,
                  { key: nextKey(rows), weekday: 1, from: "07:00", to: "11:00" },
                ]);
              }}
            >
              {t("addWindow")}
            </Button>
          ) : null}
        </fieldset>
      </Surface>

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" pending={pending} disabled={pending} className="self-start">
          {t("save")}
        </Button>
        <div aria-live="polite">
          {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
        </div>
      </div>
    </form>
  );
}

function swap(ids: string[], a: number, b: number): string[] {
  return ids.map((id, i) => (i === a ? ids[b] : i === b ? ids[a] : id) ?? id);
}
