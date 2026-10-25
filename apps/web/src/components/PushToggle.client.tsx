"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ssc/ui";
import { apiFetch } from "@/lib/api-client";

type State = "loading" | "unsupported" | "denied" | "off" | "on";

/** The VAPID public key as the bytes PushManager expects. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Production registers the worker on load; elsewhere, register it on demand.
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/**
 * Turns Web Push on or off for this device (signed-in customers). `compact` is the one-button
 * version shown on an order being prepared.
 */
export function PushToggle({
  publicKey,
  compact = false,
}: {
  publicKey: string;
  compact?: boolean;
}) {
  const t = useTranslations("Push");
  const [state, setState] = useState<State>("loading");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      )
        return "unsupported" as const;
      if (Notification.permission === "denied") return "denied" as const;
      const existing = await navigator.serviceWorker.getRegistration("/");
      const subscription = await existing?.pushManager.getSubscription();
      return subscription ? ("on" as const) : ("off" as const);
    };
    void check()
      .catch(() => "unsupported" as const)
      .then((s) => {
        if (!cancelled) setState(s);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setPending(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await registration();
      const subscription =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      await apiFetch("/api/v1/me/push", {
        method: "POST",
        body: JSON.stringify(subscription.toJSON()),
      });
      setState("on");
      setMessage(t("enabled"));
    } catch {
      setMessage(t("error"));
    } finally {
      setPending(false);
    }
  };

  const disable = async () => {
    setPending(true);
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) {
        await apiFetch("/api/v1/me/push", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setState("off");
      setMessage(t("disabled"));
    } catch {
      setMessage(t("error"));
    } finally {
      setPending(false);
    }
  };

  if (state === "loading") return null;
  if (compact && state !== "off") return null;
  return (
    <div className="flex flex-col gap-2">
      {state === "unsupported" ? (
        <p className="text-sm text-espresso-muted">{t("unsupported")}</p>
      ) : state === "denied" ? (
        <p className="text-sm text-espresso-muted">{t("denied")}</p>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size={compact ? "sm" : "md"}
          className="self-start"
          pending={pending}
          disabled={pending}
          onClick={() => void (state === "on" ? disable() : enable())}
        >
          {state === "on" ? t("disable") : compact ? t("readyCta") : t("enable")}
        </Button>
      )}
      <p className="text-sm text-espresso-muted" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
