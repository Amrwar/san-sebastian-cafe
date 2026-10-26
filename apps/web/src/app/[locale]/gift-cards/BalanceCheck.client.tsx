"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, Surface, TextField } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";

/** Balance check by code. The code is sent in the request body, never in the address. */
export function BalanceCheck() {
  const t = useTranslations("GiftCards");
  const locale = useLocale();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; last4: string; balanceCents: number; status: "active" | "disabled" }
    | { ok: false; message: string }
    | null
  >(null);

  const submit = async () => {
    if (code.trim() === "") return;
    setBusy(true);
    setResult(null);
    try {
      const card = await apiFetch<{
        last4: string;
        balanceCents: number;
        status: "active" | "disabled";
      }>("/api/v1/gift-cards/balance", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      setResult({ ok: true, ...card });
    } catch (e) {
      const kind = e instanceof ApiError ? e.failure.kind : null;
      setResult({
        ok: false,
        message:
          kind === "not_found"
            ? t("notFound")
            : kind === "rate_limited"
              ? t("tooMany")
              : t("error"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface as="section" aria-labelledby="balance-title" className="flex flex-col gap-4">
      <h2 id="balance-title" className="text-lg font-semibold text-espresso">
        {t("balanceTitle")}
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("codeLabel")}
          hint={t("codeHint")}
          autoComplete="off"
          className="min-w-0 flex-1"
          value={code}
          onChange={(e) => {
            setCode(e.currentTarget.value);
          }}
        />
        <Button type="submit" pending={busy} disabled={busy}>
          {t("check")}
        </Button>
      </form>
      <div aria-live="polite">
        {result?.ok ? (
          <Alert
            tone={result.status === "active" ? "success" : "warning"}
            title={t("balance", {
              last4: result.last4,
              amount: money(result.balanceCents, locale),
            })}
          >
            {result.status === "active" ? t("usable") : t("blocked")}
          </Alert>
        ) : result ? (
          <Alert tone="danger">{result.message}</Alert>
        ) : null}
      </div>
    </Surface>
  );
}
