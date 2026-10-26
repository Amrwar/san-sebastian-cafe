"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { stockLevel } from "@ssc/domain";
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
  /** Warn at or under this many units; null = no warning. */
  lowStockThreshold: number | null;
}

type Target = "product" | "option";

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
    target: Target,
    item: BoardItem,
    quantity: number | null,
    lowStockThreshold: number | null,
  ) => {
    setBusy(item.id);
    setMessage(null);
    try {
      const result = await apiFetch<{
        stockQuantity: number | null;
        lowStockThreshold: number | null;
      }>("/api/v1/staff/stock", {
        method: "PUT",
        body: JSON.stringify({ target, id: item.id, quantity, lowStockThreshold }),
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
            target={target}
            busy={busy === item.id}
            onAction={(s) => void apply(target, item, s)}
            onStock={(q, threshold) => void saveStock(target, item, q, threshold)}
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
  target,
  busy,
  onAction,
  onStock,
}: {
  item: BoardItem;
  target: Target;
  busy: boolean;
  onAction: (state: Action) => void;
  onStock: (quantity: number | null, lowStockThreshold: number | null) => void;
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
  const level = stockLevel({
    stock: item.stockQuantity,
    lowStockThreshold: item.lowStockThreshold,
  });
  const onSale = item.availability === "available" && !pausedUntil && level !== "out";
  const label = pausedUntil
    ? t("state.until", { time: time.format(pausedUntil) })
    : item.availability === "available" && level === "out"
      ? t("state.out_of_stock")
      : t(`state.${item.availability}`);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-lg font-semibold text-espresso">{en ? item.nameEn : item.nameFr}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-espresso-muted">
          {item.groupFr ? <span>{en ? item.groupEn : item.groupFr}</span> : null}
          <Badge tone={onSale ? "success" : "warning"}>{label}</Badge>
          {level === "low" ? (
            <Badge tone="warning">{t("state.low", { count: item.stockQuantity ?? 0 })}</Badge>
          ) : level === "ok" ? (
            <Badge tone="neutral">{t("state.in_stock", { count: item.stockQuantity ?? 0 })}</Badge>
          ) : null}
        </p>
        <StockForm item={item} busy={busy} onStock={onStock} />
        <StockHistory item={item} target={target} />
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

/** A whole number of units (0 or more), null when empty, or undefined when invalid. */
function parseUnits(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Count on hand (0 sells the item out, empty stops counting) and the alert threshold (warn at or
 * under it, empty for no alert).
 */
function StockForm({
  item,
  busy,
  onStock,
}: {
  item: BoardItem;
  busy: boolean;
  onStock: (quantity: number | null, lowStockThreshold: number | null) => void;
}) {
  const t = useTranslations("StaffAvailability");
  const locale = useLocale();
  const name = locale === "en" ? item.nameEn : item.nameFr;
  const asText = (n: number | null) => (n === null ? "" : String(n));
  const [count, setCount] = useState(asText(item.stockQuantity));
  const [threshold, setThreshold] = useState(asText(item.lowStockThreshold));
  const [errors, setErrors] = useState<{ count?: string; threshold?: string }>({});

  const submit = () => {
    const quantity = parseUnits(count);
    const lowStockThreshold = parseUnits(threshold);
    setErrors({
      count: quantity === undefined ? t("stockInvalid") : undefined,
      threshold: lowStockThreshold === undefined ? t("stockInvalid") : undefined,
    });
    if (quantity === undefined || lowStockThreshold === undefined) return;
    onStock(quantity, lowStockThreshold);
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
        value={count}
        error={errors.count}
        onChange={(e) => {
          setCount(e.currentTarget.value);
        }}
      />
      <TextField
        label={t("thresholdLabel", { name })}
        hint={t("thresholdHelp")}
        inputMode="numeric"
        className="w-56"
        value={threshold}
        error={errors.threshold}
        onChange={(e) => {
          setThreshold(e.currentTarget.value);
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
            setCount("");
            onStock(null, item.lowStockThreshold);
          }}
        >
          {t("stockUntrack")}
        </Button>
      ) : null}
    </form>
  );
}

interface Movement {
  id: string;
  reason: "sale" | "release" | "restock" | "adjustment";
  delta: number;
  quantityAfter: number | null;
  createdAt: string;
  orderNumber: string | null;
  actorName: string | null;
}

/** The item's latest stock movements from the ledger, loaded when opened. */
function StockHistory({ item, target }: { item: BoardItem; target: Target }) {
  const t = useTranslations("StaffAvailability");
  const locale = useLocale();
  const en = locale === "en";
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [failed, setFailed] = useState(false);
  const panelId = `history-${item.id}`;
  const when = new Intl.DateTimeFormat(en ? "en-CA" : "fr-CA", {
    dateStyle: "short",
    timeStyle: "short",
  });

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setFailed(false);
    try {
      const params = new URLSearchParams({ target, id: item.id });
      setRows(await apiFetch<Movement[]>(`/api/v1/staff/stock/history?${params.toString()}`));
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="mt-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => void toggle()}
      >
        {open ? t("hideHistory") : t("history")}
      </Button>
      {open ? (
        <div id={panelId} className="mt-2">
          <h3 className="sr-only">{t("historyTitle", { name: en ? item.nameEn : item.nameFr })}</h3>
          {failed ? (
            <p className="text-sm text-danger">{t("historyError")}</p>
          ) : rows === null ? null : rows.length === 0 ? (
            <p className="text-sm text-espresso-muted">{t("historyEmpty")}</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm text-espresso">
              {rows.map((m) => (
                <li key={m.id} className="flex flex-wrap gap-x-2">
                  <time dateTime={m.createdAt} className="tabular-nums text-espresso-muted">
                    {when.format(new Date(m.createdAt))}
                  </time>
                  <span className="font-semibold tabular-nums">
                    {m.delta > 0 ? `+${String(m.delta)}` : String(m.delta)}
                  </span>
                  <span>{t(`reason.${m.reason}`, { number: m.orderNumber ?? "—" })}</span>
                  {m.actorName ? <span>{t("historyBy", { name: m.actorName })}</span> : null}
                  <span className="text-espresso-muted">
                    {m.quantityAfter === null
                      ? t("historyUntracked")
                      : t("historyAfter", { count: m.quantityAfter })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
