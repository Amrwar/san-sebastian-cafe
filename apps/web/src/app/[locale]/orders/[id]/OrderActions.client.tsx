"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CAFE_TIME_ZONE } from "@ssc/domain";
import { Alert, Button, SelectField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";

/**
 * Customer self-service within policy: cancel (until the café accepts — paid orders are refunded
 * in full) and change a scheduled pickup time (until 15 minutes before). The server enforces both
 * rules; these controls only appear when the server says they're allowed.
 */
export function OrderActions({
  orderId,
  token,
  canCancel,
  canModify,
  slots,
}: {
  orderId: string;
  token: string | null;
  canCancel: boolean;
  canModify: boolean;
  slots: string[];
}) {
  const t = useTranslations("OrderDetail");
  const locale = useLocale();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [slot, setSlot] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const headers = token ? { "x-order-token": token } : undefined;
  const time = new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
    timeZone: CAFE_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  // Keep rendering after a successful action so its confirmation stays on screen.
  if (!canCancel && !canModify && !message) return null;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setPending(true);
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: success });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: t("actionError") });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {canModify && slots.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!slot) return;
            void run(
              () =>
                apiFetch(`/api/v1/orders/${orderId}`, {
                  method: "PATCH",
                  headers,
                  body: JSON.stringify({ scheduledFor: slot }),
                }),
              t("timeChanged"),
            );
          }}
        >
          <SelectField
            className="min-w-56 flex-1"
            label={t("newTime")}
            name="slot"
            value={slot}
            onChange={(e) => {
              setSlot(e.currentTarget.value);
            }}
          >
            <option value="">—</option>
            {slots.map((s) => (
              <option key={s} value={s}>
                {time.format(new Date(s))}
              </option>
            ))}
          </SelectField>
          <Button type="submit" variant="secondary" disabled={!slot || pending}>
            {t("saveTime")}
          </Button>
        </form>
      ) : null}

      {canCancel ? (
        <>
          <Button
            variant="ghost"
            className="self-start text-danger"
            onClick={() => {
              dialog.current?.showModal();
            }}
          >
            {t("cancel")}
          </Button>
          <dialog
            ref={dialog}
            aria-labelledby="cancel-title"
            className="m-auto max-w-md rounded-md border border-line bg-ivory-raised p-6 text-espresso shadow-soft backdrop:bg-espresso/50"
          >
            <h2 id="cancel-title" className="font-display text-2xl">
              {t("cancelConfirmTitle")}
            </h2>
            <p className="mt-2 text-espresso-muted">{t("cancelConfirmBody")}</p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  dialog.current?.close();
                }}
              >
                {t("cancelKeep")}
              </Button>
              <Button
                variant="danger"
                pending={pending}
                onClick={() => {
                  dialog.current?.close();
                  void run(
                    () => apiFetch(`/api/v1/orders/${orderId}/cancel`, { method: "POST", headers }),
                    t("cancelDone"),
                  );
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </dialog>
        </>
      ) : null}

      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </div>
  );
}
