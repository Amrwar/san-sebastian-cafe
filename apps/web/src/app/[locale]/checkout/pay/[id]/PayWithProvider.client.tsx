"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";

const REASONS = [
  "order_expired",
  "not_awaiting_payment",
  "payment_processing",
  "payments_unavailable",
] as const;

/**
 * Sends the customer to the provider's hosted payment page. The server creates (or reuses) the
 * page for the order's server-computed total; this button never sends an amount.
 */
export function PayWithProvider({
  orderId,
  token,
  amountLabel,
}: {
  orderId: string;
  token: string | null;
  amountLabel: string;
}) {
  const t = useTranslations("Pay");
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const pay = async () => {
    setPending(true);
    setReason(null);
    try {
      const { url } = await apiFetch<{ url: string }>(`/api/v1/orders/${orderId}/checkout`, {
        method: "POST",
        body: JSON.stringify({ locale }),
        headers: token ? { "x-order-token": token } : {},
      });
      window.location.assign(url);
    } catch (error) {
      const r =
        error instanceof ApiError && "reason" in error.failure ? error.failure.reason : null;
      setReason(r && (REASONS as readonly string[]).includes(r) ? r : "generic");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        className="w-full"
        pending={pending}
        disabled={pending}
        onClick={() => void pay()}
      >
        {pending ? t("redirecting") : t("payButton", { amount: amountLabel })}
      </Button>
      <div aria-live="polite">
        {reason ? <Alert tone="danger">{t(`reasons.${reason}`)}</Alert> : null}
      </div>
    </div>
  );
}
