"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, cn } from "@ssc/ui";
import { apiFetch } from "@/lib/api-client";

export interface BoardItem {
  id: string;
  nameFr: string;
  nameEn: string;
  groupFr?: string;
  groupEn?: string;
  availability: "available" | "sold_out" | "hidden";
  unavailableUntil: string | null;
}

type Action = "available" | "sold_out" | "disabled_for";

/** One-tap availability toggles for staff. Each change is audited on the server. */
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
}: {
  item: BoardItem;
  busy: boolean;
  onAction: (state: Action) => void;
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
  const onSale = item.availability === "available" && !pausedUntil;
  const label = pausedUntil
    ? t("state.until", { time: time.format(pausedUntil) })
    : t(`state.${item.availability}`);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-lg font-semibold text-espresso">{en ? item.nameEn : item.nameFr}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-espresso-muted">
          {item.groupFr ? <span>{en ? item.groupEn : item.groupFr}</span> : null}
          <Badge tone={onSale ? "success" : "warning"}>{label}</Badge>
        </p>
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
