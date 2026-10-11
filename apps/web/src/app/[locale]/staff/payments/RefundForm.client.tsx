"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";

/**
 * Shift leads and above. The amount is checked again on the server against what is still
 * refundable (pending refunds included); the money moves only through the payment provider.
 */
export function RefundForm({ orderId, maxCents }: { orderId: string; maxCents: number }) {
  const t = useTranslations("StaffPayments");
  const tStatus = useTranslations("PaymentHistory.status");
  const locale = useLocale();
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    const next = {
      amount:
        Number.isFinite(cents) && cents > 0 && cents <= maxCents
          ? undefined
          : t("errors.amount", { max: money(maxCents, locale) }),
      reason: reason.trim().length >= 3 ? undefined : t("errors.reason"),
    };
    setErrors(next);
    if (next.amount || next.reason) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await apiFetch<{
        refundStatus: "pending" | "succeeded" | "failed" | "cancelled";
      }>(`/api/v1/staff/orders/${orderId}/refund`, {
        method: "POST",
        body: JSON.stringify({ amountCents: cents, reason: reason.trim() }),
      });
      setMessage({
        ok: true,
        text: t("done", { status: tStatus(result.refundStatus).toLowerCase() }),
      });
      setAmount("");
      setReason("");
      router.refresh();
    } catch (error) {
      const r =
        error instanceof ApiError && "reason" in error.failure ? error.failure.reason : null;
      setMessage({
        ok: false,
        text: r === "refund_not_allowed" ? t("errors.refund_not_allowed") : t("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-semibold text-espresso">{t("refundTitle")}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("amount")}
          name="amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.currentTarget.value);
          }}
          error={errors.amount}
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setAmount((maxCents / 100).toFixed(2));
          }}
        >
          {t("full")}
        </Button>
      </div>
      <TextField
        label={t("reason")}
        name="reason"
        value={reason}
        maxLength={300}
        onChange={(e) => {
          setReason(e.currentTarget.value);
        }}
        error={errors.reason}
      />
      <Button
        type="submit"
        variant="danger"
        pending={pending}
        disabled={pending}
        className="self-start"
      >
        {t("submit")}
      </Button>
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </form>
  );
}
