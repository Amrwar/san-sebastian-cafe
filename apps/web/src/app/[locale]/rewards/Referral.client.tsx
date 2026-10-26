"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { MyReferral } from "@/server/modules/loyalty/referrals";

const REASONS = [
  "own_code",
  "already_referred",
  "not_new_customer",
  "referrer_inactive",
  "referrals_off",
] as const;

/** The customer's code to share, and (for a newcomer) where to enter the code that invited them. */
export function Referral({ referral }: { referral: MyReferral }) {
  const t = useTranslations("Referral");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setPending(true);
    setMessage(null);
    try {
      await apiFetch("/api/v1/me/referral", { method: "POST", body: JSON.stringify({ code }) });
      setMessage({ ok: true, text: t("entered", { stamps: referral.refereeStamps }) });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      const reason = f?.kind === "unprocessable" ? f.reason : null;
      setMessage({
        ok: false,
        text:
          reason && (REASONS as readonly string[]).includes(reason)
            ? t(`errors.${reason as (typeof REASONS)[number]}`)
            : f?.kind === "not_found" || f?.kind === "validation"
              ? t("errors.unknown")
              : t("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Surface className="flex flex-col gap-3">
      <h2 className="font-display text-2xl text-espresso">{t("title")}</h2>
      <p className="text-espresso-muted">
        {t("intro", { referrer: referral.referrerStamps, referee: referral.refereeStamps })}
      </p>
      {referral.code ? (
        <div className="flex flex-wrap items-center gap-3">
          <p>
            {t("yourCode")}{" "}
            <code className="rounded-sm bg-ivory-sunken px-2 py-1 text-lg font-semibold tracking-widest">
              {referral.code}
            </code>
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(referral.code ?? "").then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      ) : null}
      {referral.rewardedReferrals > 0 ? (
        <p className="text-sm text-espresso-muted">
          {t("rewarded", { count: referral.rewardedReferrals })}
        </p>
      ) : null}
      {referral.referredStatus ? (
        <p className="text-sm text-espresso-muted">{t(`status.${referral.referredStatus}`)}</p>
      ) : referral.canEnterCode ? (
        <form
          noValidate
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextField
            label={t("enterLabel")}
            hint={t("enterHint")}
            value={code}
            maxLength={7}
            autoCapitalize="characters"
            onChange={(e) => {
              setCode(e.currentTarget.value.toUpperCase());
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            pending={pending}
            disabled={pending || code.trim().length !== 7}
          >
            {t("enter")}
          </Button>
        </form>
      ) : null}
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </Surface>
  );
}
