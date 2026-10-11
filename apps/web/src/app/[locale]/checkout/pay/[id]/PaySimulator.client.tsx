"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";

/**
 * DEVELOPMENT ONLY. Calls the fake provider endpoint, which records the outcome through the same
 * server path a real provider's webhook will use. Rendered only when PAYMENT_PROVIDER=fake.
 */
export function PaySimulator({ orderId, token }: { orderId: string; token: string | null }) {
  const t = useTranslations("Pay");
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);
  const [message, setMessage] = useState<"declined" | "error" | null>(null);
  const orderPath = `/orders/${orderId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

  const simulate = async (outcome: "approve" | "decline") => {
    setPending(outcome);
    setMessage(null);
    try {
      const result = await apiFetch<{ status: string }>("/api/dev/fake-payments", {
        method: "POST",
        body: JSON.stringify({ orderId, outcome }),
        headers: token ? { "x-order-token": token } : {},
      });
      if (outcome === "decline" || result.status === "awaiting_payment") {
        setMessage("declined");
        setPending(null);
        return;
      }
      router.push(orderPath);
    } catch {
      setMessage("error");
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-md border-2 border-dashed border-warning/50 bg-warning-tint p-5">
      <div>
        <p className="font-semibold text-warning">{t("simulatorTitle")}</p>
        <p className="mt-1 text-sm text-espresso">{t("simulatorBody")}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          onClick={() => void simulate("approve")}
          pending={pending === "approve"}
          disabled={pending !== null}
        >
          {t("approve")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void simulate("decline")}
          pending={pending === "decline"}
          disabled={pending !== null}
        >
          {t("decline")}
        </Button>
      </div>
      <div aria-live="polite">
        {message ? (
          <Alert tone="danger">{message === "declined" ? t("declined") : t("error")}</Alert>
        ) : null}
      </div>
    </div>
  );
}
