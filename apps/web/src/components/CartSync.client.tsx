"use client";

import { useEffect, useRef } from "react";
import type { SavedCart } from "@/server/modules/customer/cart";
import { ApiError, apiFetch } from "@/lib/api-client";
import { cart, mergeCartLines, subscribeCart, type CartLine } from "@/lib/cart";

const SAVE_DELAY_MS = 600;

function toServer(lines: CartLine[]) {
  return lines.map(({ lineId, productId, variantId, optionIds, quantity, notes }) => ({
    lineId,
    productId,
    variantId,
    optionIds,
    quantity,
    ...(notes ? { notes } : {}),
  }));
}

/**
 * Keeps a signed-in customer's cart in their account so it follows them across devices.
 * On sign-in the device cart and the account cart are merged; afterwards every change is saved
 * (debounced) with optimistic versioning — a change made on another device is merged, not lost.
 * Renders nothing. Guests' carts stay on the device only.
 */
export function CartSync({ userId }: { userId: string }) {
  const version = useRef<number | null>(null);
  const applyingRemote = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const save = async (attempt = 0): Promise<void> => {
      if (version.current === null) return;
      try {
        const saved = await apiFetch<SavedCart>("/api/v1/me/cart", {
          method: "PUT",
          body: JSON.stringify({ lines: toServer(cart.all()), expectedVersion: version.current }),
        });
        version.current = saved.version;
      } catch (error) {
        // Another device saved first: merge its cart into ours, then save again (once).
        if (error instanceof ApiError && error.failure.kind === "conflict" && attempt === 0) {
          await sync();
          return save(1);
        }
        // Offline/other errors: keep the device cart; the next change retries the save.
      }
    };

    const sync = async () => {
      const remote = await apiFetch<SavedCart>("/api/v1/me/cart");
      if (cancelled) return;
      applyingRemote.current = true;
      cart.replaceAll(mergeCartLines(remote.lines, cart.all()));
      applyingRemote.current = false;
      version.current = remote.version;
    };

    void sync()
      .then(() => save())
      .catch(() => {
        // Offline or signed out meanwhile: the device cart keeps working; sync resumes next visit.
      });

    const unsubscribe = subscribeCart(() => {
      if (applyingRemote.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => void save(), SAVE_DELAY_MS);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [userId]);

  return null;
}
