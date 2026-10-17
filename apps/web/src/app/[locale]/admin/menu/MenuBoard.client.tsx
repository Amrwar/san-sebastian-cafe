"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, buttonClasses, CheckboxField, Surface, TextField } from "@ssc/ui";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";
import type { AdminMenuCategory } from "@/server/modules/admin/menu";

type Message = { ok: boolean; text: string } | null;

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

/** Swaps an item with its neighbour; returns null at the edges. */
function moved(ids: string[], index: number, by: -1 | 1): string[] | null {
  const target = index + by;
  if (target < 0 || target >= ids.length) return null;
  return ids.map((id, i) => (i === index ? ids[target] : i === target ? ids[index] : id) ?? id);
}

export function MenuBoard({ menu }: { menu: AdminMenuCategory[] }) {
  const t = useTranslations("AdminMenu");
  const locale = useLocale();
  const router = useRouter();
  const errorText = useErrorText();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const label = (o: { nameFr: string; nameEn: string }) => (locale === "fr" ? o.nameFr : o.nameEn);

  const run = async (action: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (ok) setMessage({ ok: true, text: ok });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  const reorder = (ids: string[] | null, categoryId?: string) => {
    if (!ids) return;
    void run(() =>
      apiFetch("/api/v1/admin/menu/order", {
        method: "PUT",
        body: JSON.stringify({ ids, ...(categoryId ? { categoryId } : {}) }),
      }),
    );
  };

  const categoryIds = menu.map((c) => c.id);
  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>

      {creating ? (
        <Surface>
          <CategoryForm
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Surface>
      ) : (
        <Button
          className="self-start"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("newCategory")}
        </Button>
      )}

      {menu.length === 0 ? <p className="text-espresso-muted">{t("noCategories")}</p> : null}

      {menu.map((category, ci) => (
        <CategorySection
          key={category.id}
          category={category}
          busy={busy}
          onMove={(by) => {
            reorder(moved(categoryIds, ci, by));
          }}
          onArchive={() =>
            run(() => apiFetch(`/api/v1/admin/categories/${category.id}`, { method: "DELETE" }))
          }
          onMoveProduct={(index, by) => {
            reorder(
              moved(
                category.products.map((p) => p.id),
                index,
                by,
              ),
              category.id,
            );
          }}
          onArchiveProduct={(id) =>
            run(() => apiFetch(`/api/v1/admin/products/${id}`, { method: "DELETE" }))
          }
          isFirst={ci === 0}
          isLast={ci === menu.length - 1}
          label={label}
        />
      ))}
    </div>
  );
}

function CategorySection({
  category,
  busy,
  onMove,
  onArchive,
  onMoveProduct,
  onArchiveProduct,
  isFirst,
  isLast,
  label,
}: {
  category: AdminMenuCategory;
  busy: boolean;
  onMove: (by: -1 | 1) => void;
  onArchive: () => Promise<void>;
  onMoveProduct: (index: number, by: -1 | 1) => void;
  onArchiveProduct: (id: string) => Promise<void>;
  isFirst: boolean;
  isLast: boolean;
  label: (o: { nameFr: string; nameEn: string }) => string;
}) {
  const t = useTranslations("AdminMenu");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const name = label(category);
  const headingId = `category-${category.id}`;

  return (
    <Surface className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={headingId}
          className="flex flex-wrap items-center gap-2 font-display text-2xl text-espresso"
        >
          {name}
          {!category.isVisible ? <Badge>{t("hidden")}</Badge> : null}
          {category.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <MoveButtons
            name={name}
            disabled={busy}
            isFirst={isFirst}
            isLast={isLast}
            onMove={onMove}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing((v) => !v);
            }}
            aria-expanded={editing}
          >
            {t("editCategory")}
          </Button>
          <ArchiveButton name={name} disabled={busy} onConfirm={onArchive} />
        </div>
      </div>

      {editing ? (
        <CategoryForm
          category={category}
          onDone={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      ) : null}

      {category.products.length === 0 ? (
        <p className="text-espresso-muted">{t("noProducts")}</p>
      ) : (
        <ul aria-labelledby={headingId} className="divide-y divide-line">
          {category.products.map((p, pi) => {
            const productName = label(p);
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={`/admin/menu/products/${p.id}`}
                    className="font-semibold text-espresso underline underline-offset-4"
                  >
                    {productName}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-espresso-muted">
                    {p.minPriceCents !== null && p.maxPriceCents !== null
                      ? p.minPriceCents === p.maxPriceCents
                        ? money(p.minPriceCents, locale)
                        : t("priceRange", {
                            min: money(p.minPriceCents, locale),
                            max: money(p.maxPriceCents, locale),
                          })
                      : null}
                    <Badge tone={p.availability === "available" ? "success" : "neutral"}>
                      {t(`availability.${p.availability}`)}
                    </Badge>
                    {p.isFeatured ? <Badge tone="brand">{t("featured")}</Badge> : null}
                    {!p.hasImage ? <Badge>{t("noImage")}</Badge> : null}
                    {p.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <MoveButtons
                    name={productName}
                    disabled={busy}
                    isFirst={pi === 0}
                    isLast={pi === category.products.length - 1}
                    onMove={(by) => {
                      onMoveProduct(pi, by);
                    }}
                  />
                  <ArchiveButton
                    name={productName}
                    disabled={busy}
                    onConfirm={() => onArchiveProduct(p.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        href={`/admin/menu/products/new?category=${category.id}`}
        className={buttonClasses("secondary", "md", "self-start")}
      >
        {t("newProduct")}
      </Link>
    </Surface>
  );
}

function MoveButtons({
  name,
  disabled,
  isFirst,
  isLast,
  onMove,
}: {
  name: string;
  disabled: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  const t = useTranslations("AdminMenu");
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("moveUp", { name })}
        disabled={disabled || isFirst}
        onClick={() => {
          onMove(-1);
        }}
      >
        ↑
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("moveDown", { name })}
        disabled={disabled || isLast}
        onClick={() => {
          onMove(1);
        }}
      >
        ↓
      </Button>
    </>
  );
}

/** Archive with an inline confirmation (no browser dialog). */
function ArchiveButton({
  name,
  disabled,
  onConfirm,
}: {
  name: string;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations("AdminMenu");
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {t("archive")}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={t("archive")} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-espresso">{t("archiveConfirm", { name })}</span>
      <Button
        size="sm"
        variant="danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          void onConfirm();
        }}
      >
        {t("confirm")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAsking(false);
        }}
      >
        {t("cancel")}
      </Button>
    </div>
  );
}

function CategoryForm({ category, onDone }: { category?: AdminMenuCategory; onDone: () => void }) {
  const t = useTranslations("AdminMenu");
  const errorText = useErrorText();
  const [values, setValues] = useState({
    nameFr: category?.nameFr ?? "",
    nameEn: category?.nameEn ?? "",
    descriptionFr: category?.descriptionFr ?? "",
    descriptionEn: category?.descriptionEn ?? "",
    isVisible: category?.isVisible ?? true,
  });
  const [errors, setErrors] = useState<{ nameFr?: string; nameEn?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof values>) => {
    setValues((v) => ({ ...v, ...patch }));
  };

  const submit = async () => {
    const next = {
      nameFr: values.nameFr.trim() ? undefined : t("errors.required"),
      nameEn: values.nameEn.trim() ? undefined : t("errors.required"),
    };
    setErrors(next);
    if (next.nameFr || next.nameEn) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch(
        category ? `/api/v1/admin/categories/${category.id}` : "/api/v1/admin/categories",
        { method: category ? "PUT" : "POST", body: JSON.stringify(values) },
      );
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("categoryNameFr")}
          lang="fr"
          value={values.nameFr}
          maxLength={60}
          error={errors.nameFr}
          onChange={(e) => {
            set({ nameFr: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("categoryNameEn")}
          lang="en"
          value={values.nameEn}
          maxLength={60}
          error={errors.nameEn}
          onChange={(e) => {
            set({ nameEn: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("descriptionFr")}
          lang="fr"
          value={values.descriptionFr}
          maxLength={300}
          onChange={(e) => {
            set({ descriptionFr: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("descriptionEn")}
          lang="en"
          value={values.descriptionEn}
          maxLength={300}
          onChange={(e) => {
            set({ descriptionEn: e.currentTarget.value });
          }}
        />
      </div>
      <CheckboxField
        label={t("visible")}
        checked={values.isVisible}
        onChange={(e) => {
          set({ isVisible: e.currentTarget.checked });
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending} disabled={pending}>
          {t("save")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {t("cancel")}
        </Button>
      </div>
      <div aria-live="polite">{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    </form>
  );
}
