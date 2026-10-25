"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, TextField } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";

const REASONS = ["orders_in_progress", "refund_pending", "staff_account"] as const;

/** Two steps: open the form, then retype the account's email to confirm. */
export function DeleteAccount({ email }: { email: string }) {
  const t = useTranslations("AccountData.delete");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  const submit = async () => {
    if (!matches) {
      setError(t("errors.mismatch"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/v1/me/data", {
        method: "DELETE",
        body: JSON.stringify({ confirmEmail: typed.trim() }),
      });
      // The session no longer exists: a full page load leaves every cached signed-in view behind.
      window.location.assign(`/${locale}/account-deleted`);
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      const reason = f?.kind === "unprocessable" ? f.reason : null;
      setError(
        reason && (REASONS as readonly string[]).includes(reason)
          ? t(`errors.${reason as (typeof REASONS)[number]}`)
          : f?.kind === "validation"
            ? t("errors.mismatch")
            : t("errors.generic"),
      );
      setPending(false);
    }
  };

  if (!open)
    return (
      <Button
        type="button"
        variant="ghost"
        className="self-start text-danger"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("start")}
      </Button>
    );

  return (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-sm border border-danger/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={t("confirmLabel", { email })}
        type="email"
        autoComplete="off"
        value={typed}
        error={error ?? undefined}
        onChange={(e) => {
          setTyped(e.currentTarget.value);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending} disabled={pending || !matches}>
          {t("confirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setTyped("");
            setError(null);
          }}
        >
          {t("cancel")}
        </Button>
      </div>
      <div aria-live="polite">{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    </form>
  );
}
