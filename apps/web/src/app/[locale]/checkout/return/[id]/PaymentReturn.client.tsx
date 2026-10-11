"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, buttonClasses, Spinner } from "@ssc/ui";
import { Link, useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";

type State = "checking" | "paid" | "processing" | "failed" | "pending" | "error";
const POLL_MS = 2500;
const MAX_POLLS = 8;

/**
 * Coming back from the hosted payment page proves nothing by itself: this asks the server, which
 * asks the provider (authenticated) and applies the answer. Polls briefly, then explains.
 */
export function PaymentReturn({ orderId, token }: { orderId: string; token: string | null }) {
  const t = useTranslations("PaymentReturn");
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  /** Bumped by "check again" to restart polling. */
  const [round, setRound] = useState(0);
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const orderPath = `/orders/${orderId}${tokenQuery}`;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let polls = 0;

    const poll = async () => {
      try {
        const view = await apiFetch<{ state: string; orderStatus: string }>(
          `/api/v1/orders/${orderId}/payment`,
          { method: "POST", headers: token ? { "x-order-token": token } : {} },
        );
        if (cancelled) return;
        polls += 1;
        if (view.state === "paid" || view.orderStatus !== "awaiting_payment") {
          setState("paid");
          router.replace(orderPath);
        } else if (view.state === "processing") {
          setState("processing");
        } else if (view.state === "failed") {
          setState("failed");
        } else if (polls >= MAX_POLLS) {
          setState("pending");
        } else {
          timer = setTimeout(() => void poll(), POLL_MS);
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    timer = setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId, orderPath, router, token, round]);

  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {state === "checking" ? (
        <p className="flex items-center gap-3 text-lg text-espresso">
          <Spinner /> {t("checking")}
        </p>
      ) : null}
      {state === "paid" ? <Alert tone="success">{t("paid")}</Alert> : null}
      {state === "processing" ? <Alert tone="brand">{t("processing")}</Alert> : null}
      {state === "failed" ? <Alert tone="danger">{t("failed")}</Alert> : null}
      {state === "pending" ? <Alert tone="warning">{t("pending")}</Alert> : null}
      {state === "error" ? <Alert tone="danger">{t("error")}</Alert> : null}

      {state !== "checking" && state !== "paid" ? (
        <div className="flex flex-wrap gap-3">
          {state === "failed" ? (
            <Link
              href={`/checkout/pay/${orderId}${tokenQuery}`}
              className={buttonClasses("primary", "md")}
            >
              {t("tryAgain")}
            </Link>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setState("checking");
                setRound((r) => r + 1);
              }}
            >
              {t("checkAgain")}
            </Button>
          )}
          <Link href={orderPath} className={buttonClasses("ghost", "md")}>
            {t("viewOrder")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
