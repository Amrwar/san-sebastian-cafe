"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Button, Surface } from "@ssc/ui";
import { apiFetch } from "@/lib/api-client";

interface IssuedCode {
  code: string;
  expiresAt: string;
}

/**
 * The short-lived code the customer shows at the counter. It only identifies them (no balance or
 * permission travels with it) and expires after a few minutes, so a screenshot is soon useless.
 */
export function CardCode() {
  const t = useTranslations("Rewards.code");
  const format = useFormatter();
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, [issued]);

  const show = async () => {
    setPending(true);
    setFailed(false);
    try {
      setIssued(await apiFetch<IssuedCode>("/api/v1/me/loyalty/card-code", { method: "POST" }));
      setNow(Date.now());
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const expired = issued ? new Date(issued.expiresAt).getTime() <= now : false;
  return (
    <Surface className="flex flex-col gap-3">
      <h2 className="font-display text-2xl text-espresso">{t("title")}</h2>
      <p className="text-espresso-muted">{t("intro")}</p>
      {issued && !expired ? (
        <div className="flex flex-col items-start gap-2">
          <p
            className="rounded-md border-2 border-espresso bg-ivory px-5 py-3 font-mono text-4xl tracking-[0.3em] text-espresso"
            aria-label={t("label", { code: issued.code.split("").join(" ") })}
          >
            {issued.code.slice(0, 4)}
            <span aria-hidden="true"> </span>
            {issued.code.slice(4)}
          </p>
          <p className="text-sm text-espresso-muted">
            {t("validUntil", {
              time: format.dateTime(new Date(issued.expiresAt), { timeStyle: "short" }),
            })}
          </p>
        </div>
      ) : null}
      {expired ? <p className="text-espresso-muted">{t("expired")}</p> : null}
      {!issued || expired ? (
        <Button
          onClick={() => void show()}
          pending={pending}
          disabled={pending}
          className="self-start"
        >
          {issued ? t("renew") : t("show")}
        </Button>
      ) : null}
      <div aria-live="polite">{failed ? <Alert tone="danger">{t("error")}</Alert> : null}</div>
    </Surface>
  );
}
