"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, buttonClasses, Surface } from "@ssc/ui";
import type { PurchaseView } from "@/server/modules/gift-cards/purchases";
import { Link } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";

/** Checks with the server every few seconds while the payment is being confirmed. */
const POLL_MS = 3000;

export function PurchaseStatus({
  initial,
  token,
  cancelled,
  simulator,
}: {
  initial: PurchaseView;
  token: string | null;
  cancelled: boolean;
  /** Development only: the payment simulator stands in for the provider's page. */
  simulator: boolean;
}) {
  const t = useTranslations("GiftCards.purchase");
  const locale = useLocale();
  const [purchase, setPurchase] = useState(initial);
  const [busy, setBusy] = useState(false);
  const headers = useMemo(() => (token ? { "x-order-token": token } : undefined), [token]);

  // Coming back from the payment page: the provider may take a moment to confirm.
  useEffect(() => {
    if (purchase.status !== "awaiting_payment" || cancelled || simulator) return;
    const timer = setInterval(() => {
      void apiFetch<PurchaseView>(`/api/v1/gift-cards/purchases/${purchase.id}/status`, {
        method: "POST",
        headers,
      })
        .then(setPurchase)
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [purchase.status, purchase.id, cancelled, simulator, headers]);

  const amount = money(purchase.amountCents, locale);
  if (purchase.status === "paid") {
    return (
      <Alert tone="success" title={t("paidTitle")}>
        <p>
          {t("paidBody", {
            amount,
            name: purchase.recipientName,
            email: purchase.recipientEmail,
          })}
        </p>
        <p className="mt-2">{t("receipt")}</p>
      </Alert>
    );
  }
  if (purchase.status === "expired" || purchase.status === "refunded") {
    return (
      <Alert tone="neutral" title={t(`${purchase.status}Title`)}>
        <p>{t(`${purchase.status}Body`)}</p>
        <Link href="/gift-cards" className={buttonClasses("secondary", "sm", "mt-3")}>
          {t("again")}
        </Link>
      </Alert>
    );
  }
  return (
    <Surface className="flex flex-col gap-4">
      <p className="text-espresso">
        {t("pending", { amount, name: purchase.recipientName, email: purchase.recipientEmail })}
      </p>
      {cancelled ? <Alert tone="neutral">{t("cancelled")}</Alert> : null}
      {simulator ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-warning p-4">
          <p className="font-semibold text-espresso">{t("simulatorTitle")}</p>
          <Button
            pending={busy}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void apiFetch<PurchaseView>("/api/dev/fake-payments/gift-card", {
                method: "POST",
                headers,
                body: JSON.stringify({ purchaseId: purchase.id }),
              })
                .then(setPurchase)
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {t("simulatorApprove")}
          </Button>
        </div>
      ) : purchase.checkoutUrl ? (
        <a href={purchase.checkoutUrl} className={buttonClasses("primary", "lg")}>
          {t("pay", { amount })}
        </a>
      ) : (
        <p aria-live="polite" className="text-espresso-muted">
          {t("confirming")}
        </p>
      )}
    </Surface>
  );
}
