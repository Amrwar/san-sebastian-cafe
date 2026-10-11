"use client";

import { useSyncExternalStore } from "react";

/**
 * The cart stored on this device. It holds ids and quantities ONLY — never prices — and is
 * re-priced by the server (/api/v1/cart/quote) every time it is shown. Survives reloads, syncs
 * across tabs, and tolerates corrupted or unavailable storage (private mode).
 */
export interface CartLine {
  lineId: string;
  productId: string;
  variantId: string;
  optionIds: string[];
  quantity: number;
}

const KEY = "ssc.cart.v1";
const MAX_LINES = 30;
const UUID = /^[0-9a-f-]{36}$/i;
const listeners = new Set<() => void>();
let memory: CartLine[] = [];
let cachedRaw: string | null | undefined;
let cachedLines: CartLine[] = [];

function isLine(value: unknown): value is CartLine {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.lineId === "string" &&
    typeof v.productId === "string" &&
    UUID.test(v.productId) &&
    typeof v.variantId === "string" &&
    UUID.test(v.variantId) &&
    Array.isArray(v.optionIds) &&
    v.optionIds.every((id) => typeof id === "string" && UUID.test(id)) &&
    typeof v.quantity === "number" &&
    Number.isInteger(v.quantity) &&
    v.quantity >= 1 &&
    v.quantity <= 20
  );
}

function read(): CartLine[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return memory;
  }
  if (raw === cachedRaw) return cachedLines;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedLines = Array.isArray(parsed) ? parsed.filter(isLine).slice(0, MAX_LINES) : [];
  } catch {
    cachedLines = [];
  }
  return cachedLines;
}

function write(lines: CartLine[]) {
  memory = lines;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Storage unavailable: keep the in-memory copy for this session.
  }
  listeners.forEach((l) => {
    l();
  });
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

const EMPTY: CartLine[] = [];

export function useCartLines(): CartLine[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function useCartCount(): number {
  return useCartLines().reduce((sum, l) => sum + l.quantity, 0);
}

function sameConfiguration(
  a: Omit<CartLine, "lineId" | "quantity">,
  b: Omit<CartLine, "lineId" | "quantity">,
) {
  return (
    a.productId === b.productId &&
    a.variantId === b.variantId &&
    [...a.optionIds].sort().join() === [...b.optionIds].sort().join()
  );
}

export const cart = {
  /** Adds a configuration; identical configurations are merged (quantity capped at 20). */
  add(item: Omit<CartLine, "lineId">): string {
    const lines = read();
    const existing = lines.find((l) => sameConfiguration(l, item));
    if (existing) {
      write(
        lines.map((l) =>
          l === existing ? { ...l, quantity: Math.min(20, l.quantity + item.quantity) } : l,
        ),
      );
      return existing.lineId;
    }
    const lineId = crypto.randomUUID();
    write([...lines, { ...item, lineId }].slice(-MAX_LINES));
    return lineId;
  },
  replace(lineId: string, item: Omit<CartLine, "lineId">) {
    write(read().map((l) => (l.lineId === lineId ? { ...item, lineId } : l)));
  },
  setQuantity(lineId: string, quantity: number) {
    write(
      read().map((l) =>
        l.lineId === lineId ? { ...l, quantity: Math.min(20, Math.max(1, quantity)) } : l,
      ),
    );
  },
  remove(lineId: string) {
    write(read().filter((l) => l.lineId !== lineId));
  },
  clear() {
    write([]);
  },
  get(lineId: string): CartLine | undefined {
    return read().find((l) => l.lineId === lineId);
  },
};
