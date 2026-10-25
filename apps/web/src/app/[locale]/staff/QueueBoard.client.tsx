"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { OrderStatus } from "@ssc/domain";
import { Alert, Badge, Button, buttonClasses, cn, EmptyState } from "@ssc/ui";
import type { QueueOrder, StaffQueue } from "@/server/modules/ordering/staff-queue";
import { Link } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

const COLUMNS = ["paid", "accepted", "in_preparation", "ready"] as const;
type Column = (typeof COLUMNS)[number];
/** Beyond this, a countdown stops being useful; the card shows the pickup time instead. */
const FAR_AHEAD_MINUTES = 90;

const FORWARD: Partial<Record<OrderStatus, OrderStatus>> = {
  paid: "accepted",
  accepted: "in_preparation",
  in_preparation: "ready",
  ready: "completed",
};
/** Polling while the live stream is unavailable. */
const POLL_MS = 10_000;

/** Short two-tone chime generated in the browser (no audio file). Requires a prior user tap. */
function chime(context: AudioContext) {
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, context.currentTime + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + i * 0.18 + 0.3);
    osc.connect(gain).connect(context.destination);
    osc.start(context.currentTime + i * 0.18);
    osc.stop(context.currentTime + i * 0.18 + 0.32);
  }
}

/**
 * Tablet-first live queue for busy service. Changes arrive within seconds over server-sent events
 * (polling while the stream is down); every action carries the order version so two baristas
 * can't double-apply a change.
 */
export function QueueBoard({
  initial,
  canPause,
  canRefund,
}: {
  initial: StaffQueue;
  canPause: boolean;
  canRefund: boolean;
}) {
  const t = useTranslations("StaffQueue");
  const locale = useLocale();
  const tag = locale === "en" ? "en-CA" : "fr-CA";
  const [queue, setQueue] = useState(initial);
  const [connection, setConnection] = useState<"live" | "retrying">("live");
  const [updatedAt, setUpdatedAt] = useState(() => new Date(initial.serverTime));
  const [notice, setNotice] = useState<{
    tone: "danger" | "success" | "neutral";
    text: string;
  } | null>(null);
  const [column, setColumn] = useState<Column>("paid");
  const [soundOn, setSoundOn] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{ order: QueueOrder; to: OrderStatus } | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef(new Set(initial.orders.map((o) => o.id)));
  const [announcement, setAnnouncement] = useState("");

  /** Shows a new state of the queue, announcing (and chiming for) orders not seen before. */
  const apply = useCallback(
    (next: StaffQueue) => {
      const fresh = next.orders.filter((o) => o.status === "paid" && !seen.current.has(o.id));
      for (const o of next.orders) seen.current.add(o.id);
      if (fresh.length > 0) {
        setAnnouncement(fresh.map((o) => t("newOrder", { number: o.number })).join(". "));
        if (audio.current) chime(audio.current);
      }
      setQueue(next);
      setUpdatedAt(new Date(next.serverTime));
    },
    [t],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await apiFetch<StaffQueue>("/api/v1/staff/orders", { timeoutMs: 8000 }));
    } catch {
      setConnection("retrying");
    }
  }, [apply]);

  // Live updates by server-sent events; while the stream is down, poll instead. The browser
  // reconnects the stream by itself (it also ends on purpose every few minutes).
  useEffect(() => {
    let streaming = false;
    const source = new EventSource("/api/v1/staff/orders/stream");
    source.addEventListener("open", () => {
      streaming = true;
      setConnection("live");
    });
    source.addEventListener("update", (event) => {
      streaming = true;
      setConnection("live");
      apply(JSON.parse((event as MessageEvent<string>).data) as StaffQueue);
    });
    source.addEventListener("error", () => {
      streaming = false;
    });
    const fallback = setInterval(() => {
      if (!streaming) void refresh();
    }, POLL_MS);
    return () => {
      clearInterval(fallback);
      source.close();
    };
  }, [apply, refresh]);

  const act = async (order: QueueOrder, to: OrderStatus, reason?: string) => {
    setBusyId(order.id);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/staff/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to, reason, expectedVersion: order.version }),
      });
    } catch (error) {
      const conflict = error instanceof ApiError && error.failure.kind === "conflict";
      setNotice({ tone: "danger", text: conflict ? t("conflict") : t("actionError") });
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const pause = async (minutes: number) => {
    try {
      await apiFetch("/api/v1/staff/pause", { method: "POST", body: JSON.stringify({ minutes }) });
    } catch {
      setNotice({ tone: "danger", text: t("actionError") });
    }
    await refresh();
  };

  const time = new Intl.DateTimeFormat(tag, { hour: "numeric", minute: "2-digit" });
  const now = updatedAt.getTime();
  const byColumn = (c: Column) => queue.orders.filter((o) => o.status === c);

  return (
    <div className="flex flex-col gap-5">
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-espresso-muted" aria-live="polite">
          {connection === "live"
            ? `${t("live")} · ${t("updatedAt", { time: time.format(updatedAt) })}`
            : t("reconnecting")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line-strong px-4">
            <input
              type="checkbox"
              className="size-5 accent-burgundy"
              checked={soundOn}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setSoundOn(on);
                if (on) {
                  audio.current ??= new AudioContext();
                  void audio.current.resume();
                  chime(audio.current);
                } else audio.current = null;
              }}
            />
            {t("sound")}
          </label>
          <Link href="/staff/availability" className={buttonClasses("secondary")}>
            {t("availability")}
          </Link>
          <Link href="/staff/loyalty" className={buttonClasses("secondary")}>
            {t("loyalty")}
          </Link>
          {canRefund ? (
            <Link href="/staff/payments" className={buttonClasses("secondary")}>
              {t("payments")}
            </Link>
          ) : null}
        </div>
      </div>

      {queue.pausedUntil ? (
        <Alert
          tone="warning"
          title={t("pausedUntil", { time: time.format(new Date(queue.pausedUntil)) })}
        >
          {canPause ? (
            <Button size="sm" className="mt-2" onClick={() => void pause(0)}>
              {t("resume")}
            </Button>
          ) : null}
        </Alert>
      ) : canPause ? (
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60].map((m) => (
            <Button key={m} variant="secondary" size="sm" onClick={() => void pause(m)}>
              {t("pause", { minutes: m })}
            </Button>
          ))}
        </div>
      ) : null}

      <div aria-live="polite">
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      </div>

      {/* Narrow screens: one column at a time. Large tablets (landscape) and up: all four. */}
      <div
        role="group"
        aria-label={t("title")}
        className="flex gap-2 overflow-x-auto pb-1 lg:hidden"
      >
        {COLUMNS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={column === c}
            onClick={() => {
              setColumn(c);
            }}
            className={cn(
              "inline-flex min-h-12 shrink-0 items-center gap-2 rounded-pill border px-5 text-base font-semibold",
              column === c
                ? "border-burgundy bg-burgundy text-ivory"
                : "border-line-strong bg-ivory-raised text-espresso",
            )}
          >
            {t(`columns.${c}`)}
            <span className="rounded-pill bg-ivory/20 px-2 tabular-nums">{byColumn(c).length}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        {COLUMNS.map((c) => (
          <section
            key={c}
            aria-labelledby={`col-${c}`}
            className={cn("flex flex-col gap-3", column === c ? "" : "hidden lg:flex")}
          >
            <h2
              id={`col-${c}`}
              className="flex items-center justify-between rounded-sm bg-espresso px-4 py-2 font-semibold text-ivory"
            >
              {t(`columns.${c}`)}
              <span className="tabular-nums">{byColumn(c).length}</span>
            </h2>
            {byColumn(c).length === 0 ? (
              <EmptyState title={t("empty")} />
            ) : (
              byColumn(c).map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  now={now}
                  busy={busyId === o.id}
                  onForward={(to) => void act(o, to)}
                  onNeedsReason={(to) => {
                    setReasonFor({ order: o, to });
                  }}
                  onNotesSaved={() => void refresh()}
                />
              ))
            )}
          </section>
        ))}
      </div>

      {queue.recentlyCompleted.length > 0 ? (
        <section aria-labelledby="recent-title">
          <h2 id="recent-title" className="mb-2 font-display text-xl text-espresso">
            {t("recent")}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {queue.recentlyCompleted.map((o) => (
              <li key={o.id}>
                <Badge>
                  {o.number} · {o.customerName}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reasonFor ? (
        <ReasonDialog
          title={`${t(`actions.${reasonFor.to as "rejected" | "cancelled"}`)} — ${reasonFor.order.number}`}
          onCancel={() => {
            setReasonFor(null);
          }}
          onConfirm={(reason) => {
            const target = reasonFor;
            setReasonFor(null);
            void act(target.order, target.to, reason);
          }}
        />
      ) : null}
    </div>
  );
}

function OrderCard({
  order,
  now,
  busy,
  onForward,
  onNeedsReason,
  onNotesSaved,
}: {
  order: QueueOrder;
  now: number;
  busy: boolean;
  onForward: (to: OrderStatus) => void;
  onNeedsReason: (to: OrderStatus) => void;
  onNotesSaved: () => void;
}) {
  const t = useTranslations("StaffQueue");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const en = locale === "en";
  const due = new Date(order.readyBy).getTime();
  const minutes = Math.round((due - now) / 60_000);
  const late = minutes < 0;
  const forward = FORWARD[order.status];
  const canForward = forward !== undefined && order.actions.includes(forward);
  const time = new Intl.DateTimeFormat(en ? "en-CA" : "fr-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
  const farTime = new Intl.DateTimeFormat(en ? "en-CA" : "fr-CA", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <article
      aria-labelledby={`order-${order.id}`}
      className={cn(
        "flex flex-col gap-3 rounded-md border-2 bg-ivory-raised p-4 shadow-soft",
        late && order.status !== "ready" ? "border-danger" : "border-line",
      )}
    >
      <header className="flex flex-col gap-2">
        {/* The number is what staff call out: one line, never split at the hyphen. */}
        <h3
          id={`order-${order.id}`}
          className="font-display text-3xl leading-none whitespace-nowrap text-espresso"
        >
          {order.number}
        </h3>
        <p className="text-lg font-semibold text-espresso">{order.customerName}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-pill px-3 py-1 text-sm font-bold",
              late ? "bg-danger text-ivory" : "bg-ivory-sunken text-espresso",
            )}
          >
            {late
              ? t("late", { minutes: -minutes })
              : minutes <= 0
                ? t("dueNow")
                : minutes > FAR_AHEAD_MINUTES
                  ? // A countdown in hundreds of minutes isn't useful: show the pickup time.
                    t("scheduled", { time: farTime.format(due) })
                  : t("dueIn", { minutes })}
          </span>
          {minutes > FAR_AHEAD_MINUTES ? null : (
            <span className="text-xs text-espresso-muted">
              {order.scheduled ? t("scheduled", { time: time.format(due) }) : t("asap")}
            </span>
          )}
          {order.fulfilment === "delivery" ? <Badge tone="brand">{t("delivery")}</Badge> : null}
          {order.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
        </div>
      </header>

      <ul className="flex flex-col gap-2 border-y border-line py-3">
        {order.items.map((i) => (
          <li key={i.id}>
            <p className="text-lg leading-snug">
              <span className="font-bold tabular-nums">{i.quantity} ×</span>{" "}
              {en ? i.nameEn : i.nameFr}{" "}
              <span className="text-espresso-muted">· {en ? i.variantEn : i.variantFr}</span>
            </p>
            {(en ? i.modifiersEn : i.modifiersFr).length > 0 ? (
              <p className="font-semibold text-burgundy">
                {(en ? i.modifiersEn : i.modifiersFr).join(" · ")}
              </p>
            ) : null}
            {i.notes ? (
              <p className="mt-1 rounded-sm bg-crema-soft px-2 py-1 text-sm font-medium text-espresso">
                “{i.notes}”
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {order.notes ? (
        <p className="rounded-sm bg-crema-soft px-3 py-2 text-sm text-espresso">
          <span className="font-semibold">{t("customerNote")} :</span> {order.notes}
        </p>
      ) : null}

      <StaffNotes order={order} onSaved={onNotesSaved} />

      {canForward ? (
        <Button
          size="lg"
          className="min-h-14 w-full text-lg"
          pending={busy}
          disabled={busy}
          onClick={() => {
            onForward(forward);
          }}
        >
          {t(`actions.${forward as "accepted" | "in_preparation" | "ready" | "completed"}`)}
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(["rejected", "cancelled"] as const)
          .filter((s) => order.actions.includes(s))
          .map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              className="text-danger"
              disabled={busy}
              onClick={() => {
                onNeedsReason(s);
              }}
            >
              {t(`actions.${s}`)}
            </Button>
          ))}
      </div>
    </article>
  );
}

function StaffNotes({ order, onSaved }: { order: QueueOrder; onSaved: () => void }) {
  const t = useTranslations("StaffQueue");
  const [value, setValue] = useState(order.staffNotes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  return (
    <details className="text-sm" open={Boolean(order.staffNotes)}>
      <summary className="min-h-11 cursor-pointer content-center font-semibold text-espresso-muted">
        {t("staffNotes")}
      </summary>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setState("saving");
          apiFetch(`/api/v1/staff/orders/${order.id}/notes`, {
            method: "PUT",
            body: JSON.stringify({ staffNotes: value }),
          })
            .then(() => {
              setState("saved");
              onSaved();
            })
            .catch(() => {
              setState("error");
            });
        }}
      >
        <label htmlFor={`notes-${order.id}`} className="sr-only">
          {t("staffNotes")}
        </label>
        <textarea
          id={`notes-${order.id}`}
          rows={2}
          maxLength={500}
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            setState("idle");
          }}
          className="w-full rounded-sm border border-line-strong bg-ivory px-3 py-2 text-base"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" variant="secondary" pending={state === "saving"}>
            {t("saveNotes")}
          </Button>
          <span aria-live="polite" className={state === "error" ? "text-danger" : "text-success"}>
            {state === "saved" ? t("notesSaved") : state === "error" ? t("actionError") : ""}
          </span>
        </div>
      </form>
    </details>
  );
}

function ReasonDialog({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("StaffQueue");
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="reason-title"
      onClose={onCancel}
      className="m-auto w-full max-w-md rounded-md border border-line bg-ivory-raised p-6 text-espresso shadow-soft backdrop:bg-espresso/50"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3) {
            setError(true);
            return;
          }
          onConfirm(reason.trim());
        }}
      >
        <h2 id="reason-title" className="font-display text-2xl">
          {title}
        </h2>
        <p className="text-sm text-espresso-muted">{t("refundNote")}</p>
        <label htmlFor="reason" className="text-sm font-semibold">
          {t("reasonLabel")}
        </label>
        <textarea
          id="reason"
          rows={3}
          maxLength={300}
          value={reason}
          aria-invalid={error || undefined}
          aria-describedby={error ? "reason-error" : undefined}
          onChange={(e) => {
            setReason(e.currentTarget.value);
            setError(false);
          }}
          className="w-full rounded-sm border border-line-strong bg-ivory px-3 py-2 text-base"
        />
        {error ? (
          <p id="reason-error" className="text-sm font-medium text-danger">
            {t("reasonRequired")}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            {t("back")}
          </Button>
          <Button type="submit" variant="danger">
            {t("confirm")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
