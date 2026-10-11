"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CartQuoteInput, CartQuoteResult } from "@/server/modules/ordering/cart-quote";
import { ApiError, apiFetch, type ApiFailure } from "./api-client";
import type { CartLine } from "./cart";

export type QuoteOptions = Omit<CartQuoteInput, "lines">;

export interface QuoteState {
  /** Last successful quote (kept while a newer one loads, so the UI doesn't flash). */
  data: CartQuoteResult | null;
  loading: boolean;
  /** True when a request has been pending for more than 2.5 s. */
  slow: boolean;
  error: ApiFailure | null;
  retry: () => void;
}

const SLOW_AFTER_MS = 2500;

/** Server-priced quote for the current cart. Debounced, cancellable, retries when back online. */
export function useCartQuote(lines: CartLine[], options: QuoteOptions): QuoteState {
  const [data, setData] = useState<CartQuoteResult | null>(null);
  // The request body of the last completed request (success or failure).
  const [settledBody, setSettledBody] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const errorRef = useRef<ApiFailure | null>(null);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const body = JSON.stringify({
    lines: lines.map(({ lineId, productId, variantId, optionIds, quantity }) => ({
      lineId,
      productId,
      variantId,
      optionIds,
      quantity,
    })),
    ...options,
  });

  useEffect(() => {
    // An empty cart needs no quote (the returned state below is derived for that case).
    if (lines.length === 0) return;
    const controller = new AbortController();
    const slowTimer = setTimeout(() => {
      setSlow(true);
    }, SLOW_AFTER_MS);
    const debounce = setTimeout(() => {
      apiFetch<CartQuoteResult>("/api/v1/cart/quote", {
        method: "POST",
        body,
        signal: controller.signal,
      })
        .then((result) => {
          setData(result);
          setError(null);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setError(e instanceof ApiError ? e.failure : { kind: "server", requestId: null });
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          clearTimeout(slowTimer);
          setSlow(false);
          setSettledBody(body);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(debounce);
      clearTimeout(slowTimer);
    };
    // `body` captures every input; `attempt` forces a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, attempt]);

  useEffect(() => {
    const onOnline = () => {
      if (errorRef.current) setAttempt((n) => n + 1);
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const empty = lines.length === 0;
  return {
    data: empty ? null : data,
    loading: empty ? false : settledBody !== body,
    slow: empty ? false : slow,
    error: empty ? null : error,
    retry,
  };
}
