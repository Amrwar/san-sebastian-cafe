"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, SelectField, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

/*
 * Shift-lead corrections on a customer's card. Every action asks for a reason (the customer sees
 * it in their history) and carries an idempotency key, so a double tap changes the card once.
 */

function useErrorText() {
  const t = useTranslations("StaffLoyalty");
  return (error: unknown) => {
    if (error instanceof ApiError) {
      const f = error.failure;
      if (f.kind === "forbidden") return t("errors.forbidden");
      if (f.kind === "validation" && f.fields.includes("stamps"))
        return t("errors.exceeds_balance");
      if ("reason" in f && f.reason && t.has(`errors.${f.reason}`))
        return t(`errors.${f.reason}` as "errors.generic");
    }
    return t("errors.generic");
  };
}

/**
 * A button that asks for a reason before it acts (cancel a counter purchase, withdraw a reward).
 * `body` carries the idempotency key where the endpoint takes one.
 */
export function ReasonAction({
  label,
  path,
  body,
}: {
  label: string;
  path: string;
  body: Record<string, unknown>;
}) {
  const t = useTranslations("StaffLoyalty");
  const errorText = useErrorText();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError(t("errors.reason"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ ...body, reason: reason.trim() }),
      });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      noValidate
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={t("confirmVoid")}
        name="reason"
        value={reason}
        maxLength={300}
        onChange={(e) => {
          setReason(e.currentTarget.value);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" pending={pending} disabled={pending}>
          {t("confirm")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
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

/** Add or remove stamps, or forgive stamps owed. */
export function AdjustForm({ userId, debt }: { userId: string; debt: number }) {
  const t = useTranslations("StaffLoyalty");
  const errorText = useErrorText();
  const router = useRouter();
  const [action, setAction] = useState<"stamps" | "forgive_debt">("stamps");
  const [stamps, setStamps] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{ stamps?: string; reason?: string }>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const submit = async () => {
    const n = Number(stamps.replace("−", "-"));
    const next = {
      stamps:
        action === "stamps" && (!Number.isInteger(n) || n === 0 || Math.abs(n) > 20)
          ? t("errors.stamps")
          : undefined,
      reason: reason.trim().length >= 3 ? undefined : t("errors.reason"),
    };
    setErrors(next);
    if (next.stamps || next.reason) return;
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/staff/loyalty/customers/${encodeURIComponent(userId)}/adjust`, {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(action === "stamps" ? { stamps: n } : {}),
          reason: reason.trim(),
          idempotencyKey: key,
        }),
      });
      setMessage({ ok: true, text: t("done") });
      setStamps("");
      setReason("");
      setKey(crypto.randomUUID());
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
      if (e instanceof ApiError && e.failure.kind !== "timeout" && e.failure.kind !== "offline")
        setKey(crypto.randomUUID());
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
      {debt > 0 ? (
        <SelectField
          label={t("action")}
          value={action}
          onChange={(e) => {
            setAction(e.currentTarget.value === "forgive_debt" ? "forgive_debt" : "stamps");
          }}
        >
          <option value="stamps">{t("actions.stamps")}</option>
          <option value="forgive_debt">{t("actions.forgive_debt")}</option>
        </SelectField>
      ) : null}
      {action === "stamps" ? (
        <TextField
          label={t("stamps")}
          name="stamps"
          inputMode="numeric"
          value={stamps}
          error={errors.stamps}
          onChange={(e) => {
            setStamps(e.currentTarget.value);
          }}
        />
      ) : null}
      <TextField
        label={t("reason")}
        name="reason"
        value={reason}
        maxLength={300}
        error={errors.reason}
        onChange={(e) => {
          setReason(e.currentTarget.value);
        }}
      />
      <Button type="submit" pending={pending} disabled={pending} className="self-start">
        {t("apply")}
      </Button>
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </form>
  );
}
