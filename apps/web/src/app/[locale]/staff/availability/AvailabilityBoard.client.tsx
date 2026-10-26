"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, cn, TextField } from "@ssc/ui";
import { apiFetch } from "@/lib/api-client";

export interface BoardItem {
  id: string;
  nameFr: string;
  nameEn: string;
  groupFr?: string;
  groupEn?: string;
  availability: "available" | "sold_out" | "hidden";
  unavailableUntil: string | null;
  /** Units left when counted; null = not counted. */
  stockQuantity: number | null;
}

type Action = "available" | "sold_out" | "disabled_for";

/** One-tap availability toggles and stock counts for staff. Each change is audited on the server. */
export function AvailabilityBoard({
  products,
  options,
}: {
  products: BoardItem[];
  options: BoardItem[];
}) {
  const t = useTranslations("StaffAvailability");
  const [items, setItems] = useState({ product: products, option: options });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const locale = useLocale();
  const en = locale === "en";

  const apply = async (target: "product" | "option", item: BoardItem, state: Action) => {
    setBusy(item.id);
    setMessage(null);
    try {
      const result = await apiFetch<{
        availability: BoardItem["availability"];
        unavailableUntil: string | null;
      }>("/api/v1/staff/availability", {
        method: "PUT",
        body: JSON.stringify({
          target,
          id: item.id,
          state,
          ...(state === "disabled_for" ? { minutes: 60 } : {}),
        }),
      });
      setItems((prev) => ({
        ...prev,
        [target]: prev[target].map((i) => (i.id === item.id ? { ...i, ...result } : i)),
      }));
      setMessage({ ok: true, text: t("saved", { name: en ? item.nameEn : item.nameFr }) });
    } catch {
      setMessage({ ok: false, text: t("error") });
    } finally {
      setBusy(null);
    }
  };

  const saveStock = async (
    target: "product" | "option",
    item: BoardItem,
    quantity: number | null,
  ) => {
    setBusy(item.id);
    setMessage(null);
    try {
      const result = await apiFetch<{ stockQuantity: number | null }>("/api/v1/staff/stock", {
        method: "PUT",
        body: JSON.stringify({ target, id: item.id, quantity }),
      });
      setItems((prev) => ({
        ...prev,
        [target]: prev[target].map((i) => (i.id === item.id ? { ...i, ...result } : i)),
      }));
      setMessage({ ok: true, text: t("stockSaved", { name: en ? item.nameEn : item.nameFr }) });
    } catch {
      setMessage({ ok: false, text: t("error") });
    } finally {
      setBusy(null);
    }
  };

  const section = (target: "product" | "option", title: string) => (
    <section aria-labelledby={`avail-${target}`} className="flex flex-col gap-3">
      <h2 id={`avail-${target}`} className="font-display text-2xl text-espresso">
        {title}
      </h2>
      <ul className="divide-y divide-line rounded-md border border-line bg-ivory-raised">
        {items[target].map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            busy={busy === item.id}
            onAction={(s) => void apply(target, item, s)}
            onStock={(q) => void saveStock(target, item, q)}
          />
        ))}
      </ul>
    </section>
  );

  return (
    <div className="flex flex-col gap-8">
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
      {section("product", t("products"))}
      {section("option", t("options"))}
    </div>
  );
}

function ItemRow({
  item,
  busy,
  onAction,
  onStock,
}: {
  item: BoardItem;
  busy: boolean;
  onAction: (state: Action) => void;
  onStock: (quantity: number | null) => void;
}) {
  const t = useTranslations("StaffAvailability");
  const locale = useLocale();
  const en = locale === "en";
  const pausedUntil =
    item.unavailableUntil && new Date(item.unavailableUntil) > new Date()
      ? new Date(item.unavailableUntil)
      : null;
  const time = new Intl.DateTimeFormat(en ? "en-CA" : "fr-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
  const outOfStock = item.stockQuantity === 0;
  const onSale = item.availability === "available" && !pausedUntil && !outOfStock;
  const label = pausedUntil
    ? t("state.until", { time: time.format(pausedUntil) })
    : item.availability === "available" && outOfStock
      ? t("state.out_of_stock")
      : t(`state.${item.availability}`);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-lg font-semibold text-espresso">{en ? item.nameEn : item.nameFr}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-espresso-muted">
          {item.groupFr ? <span>{en ? item.groupEn : item.groupFr}</span> : null}
          <Badge tone={onSale ? "success" : "warning"}>{label}</Badge>
          {item.stockQuantity !== null && item.stockQuantity > 0 ? (
            <Badge tone="neutral">{t("state.in_stock", { count: item.stockQuantity })}</Badge>
          ) : null}
        </p>
        <StockForm item={item} busy={busy} onStock={onStock} />
      </div>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={en ? item.nameEn : item.nameFr}
      >
        {(
          [
            ["available", t("onSale")],
            ["sold_out", t("soldOut")],
            ["disabled_for", t("disable60")],
          ] as const
        ).map(([state, text]) => {
          const active =
            state === "available"
              ? onSale
              : state === "sold_out"
                ? item.availability === "sold_out"
                : Boolean(pausedUntil);
          return (
            <Button
              key={state}
              size="md"
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              disabled={busy}
              className={cn("min-w-28")}
              onClick={() => {
                onAction(state);
              }}
            >
              {text}
            </Button>
          );
        })}
      </div>
    </li>
  );
}

/** Count on hand: a number (0 sells the item out) or empty to stop counting. */
function StockForm({
  item,
  busy,
  onStock,
}: {
  item: BoardItem;
  busy: boolean;
  onStock: (quantity: number | null) => void;
}) {
  const t = useTranslations("StaffAvailability");
  const locale = useLocale();
  const name = locale === "en" ? item.nameEn : item.nameFr;
  const [text, setText] = useState(item.stockQuantity === null ? "" : String(item.stockQuantity));
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setError(undefined);
      onStock(null);
      return;
    }
    if (!/^\d{1,6}$/.test(trimmed)) {
      setError(t("stockInvalid"));
      return;
    }
    setError(undefined);
    onStock(Number(trimmed));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mt-2 flex flex-wrap items-end gap-2"
    >
      <TextField
        label={t("stockLabel", { name })}
        hint={t("stockHelp")}
        inputMode="numeric"
        className="w-56"
        value={text}
        error={error}
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
      />
      <Button type="submit" size="md" variant="secondary" disabled={busy}>
        {t("stockSave")}
      </Button>
      {item.stockQuantity !== null ? (
        <Button
          type="button"
          size="md"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setText("");
            onStock(null);
          }}
        >
          {t("stockUntrack")}
        </Button>
      ) : null}
    </form>
  );
}
