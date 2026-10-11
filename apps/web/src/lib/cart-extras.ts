"use client";

import { useSyncExternalStore } from "react";

/** Customer choices that travel from cart to checkout. Contains no prices or personal data. */
export interface CartExtras {
  promoCode: string;
  useReward: boolean;
}

const KEY = "ssc.cart-extras.v1";
const EMPTY: CartExtras = { promoCode: "", useReward: false };
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: CartExtras = EMPTY;

function read(): CartExtras {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return cached;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<CartExtras>) : {};
    cached = {
      promoCode: typeof parsed.promoCode === "string" ? parsed.promoCode.slice(0, 32) : "",
      useReward: parsed.useReward === true,
    };
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCartExtras(): CartExtras {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function setCartExtras(next: Partial<CartExtras>) {
  const value = { ...read(), ...next };
  cached = value;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
    cachedRaw = window.localStorage.getItem(KEY);
  } catch {
    // Storage unavailable: keep in memory for this session.
  }
  listeners.forEach((l) => {
    l();
  });
}
