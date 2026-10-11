"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { OrderStatus } from "@ssc/domain";
import { Alert, cn } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";

const STEPS = ["paid", "accepted", "in_preparation", "ready", "completed"] as const;
const FINAL: readonly OrderStatus[] = [
  "completed",
  "cancelled",
  "expired",
  "refunded",
  "partially_refunded",
];
const BASE_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 60_000;

interface StatusResponse {
  status: OrderStatus;
  updatedAt: string;
}

/**
 * Live order status. Polls the server (the only source of truth); backs off after failures,
 * pauses while offline or while the tab is hidden, and stops once the order is finished.
 * Real-time push (SSE) replaces polling in Phase 7.
 */
export function Tracking({
  orderId,
  number,
  initialStatus,
}: {
  orderId: string;
  number: string;
  initialStatus: OrderStatus;
}) {
  const t = useTranslations("Tracking");
  const locale = useLocale();
  const [status, setStatus] = useState<OrderStatus>(initialStatus);
  const [updatedAt, setUpdatedAt] = useState<Date>(() => new Date());
  const [connection, setConnection] = useState<"live" | "retrying" | "offline">("live");
  const failures = useRef(0);
  const done = FINAL.includes(status);

  useEffect(() => {
    if (done) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // Read through a function: the abort can happen while a request is in flight.
    const isAborted = () => controller.signal.aborted;

    const schedule = () => {
      const delay = Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * 2 ** failures.current);
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (isAborted()) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      if (!navigator.onLine) {
        setConnection("offline");
        return;
      }
      try {
        const next = await apiFetch<StatusResponse>(`/api/v1/me/orders/${orderId}/status`, {
          signal: controller.signal,
          timeoutMs: 8000,
        });
        failures.current = 0;
        setStatus(next.status);
        setUpdatedAt(new Date());
        setConnection("live");
        if (!FINAL.includes(next.status)) schedule();
      } catch (error) {
        // Unmounted (aborted): never schedule another poll.
        if (isAborted()) return;
        failures.current += 1;
        setConnection(
          error instanceof ApiError && error.failure.kind === "offline" ? "offline" : "retrying",
        );
        schedule();
      }
    };
    const onOnline = () => {
      clearTimeout(timer);
      failures.current = 0;
      void poll();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onOnline();
    };

    schedule();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [orderId, done]);

  const currentIndex = STEPS.indexOf(status as (typeof STEPS)[number]);
  const time = new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (status === "cancelled" || status === "expired")
    return <Alert tone="warning">{t("cancelled")}</Alert>;
  if (status === "refunded" || status === "partially_refunded")
    return <Alert tone="neutral">{t("refunded")}</Alert>;

  return (
    <section aria-labelledby="tracking-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tracking-title" className="font-display text-2xl text-espresso">
          {t("title")}
        </h2>
        <p className="text-sm text-espresso-muted" aria-live="polite">
          {done
            ? t("done")
            : connection === "offline"
              ? t("offline")
              : connection === "retrying"
                ? t("reconnecting")
                : `${t("live")} · ${t("updatedAt", { time: time.format(updatedAt) })}`}
        </p>
      </div>

      {status === "ready" ? (
        <Alert tone="success" title={t("ready")} role="status">
          {t("readyHint", { number })}
        </Alert>
      ) : null}

      <ol className="flex flex-col gap-0">
        {STEPS.map((step, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
          return (
            <li
              key={step}
              className="relative flex items-start gap-4 pb-6 last:pb-0"
              aria-current={state === "current" ? "step" : undefined}
            >
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute start-[0.9rem] top-8 h-[calc(100%-2rem)] w-0.5",
                    i < currentIndex ? "bg-burgundy" : "bg-line",
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-pill border-2 text-sm font-bold",
                  state === "done" && "border-burgundy bg-burgundy text-ivory",
                  state === "current" &&
                    "border-burgundy bg-ivory-raised text-burgundy motion-safe:animate-pulse",
                  state === "upcoming" && "border-line-strong bg-ivory text-espresso-muted",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="pt-1">
                <span
                  className={cn(
                    "font-semibold",
                    state === "upcoming" ? "text-espresso-muted" : "text-espresso",
                  )}
                >
                  {t(`steps.${step}`)}
                </span>
                <span className="sr-only"> — {t(`stepState.${state}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
