"use client";

import { useTranslations } from "next-intl";
import { Alert, Button } from "@ssc/ui";
import type { ApiFailure } from "@/lib/api-client";

/** Standard message + retry action for a failed request; also used for slow networks. */
export function RequestProblem({ failure, onRetry }: { failure: ApiFailure; onRetry: () => void }) {
  const t = useTranslations("Common");
  const message =
    failure.kind === "offline"
      ? `${t("offline")} ${t("offlineHint")}`
      : failure.kind === "timeout"
        ? t("timeout")
        : t("serverError");
  return (
    <Alert tone="danger" role="alert">
      <p>{message}</p>
      {failure.kind === "server" && failure.requestId ? (
        <p className="mt-1 font-mono text-xs">{t("reference", { id: failure.requestId })}</p>
      ) : null}
      <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
        {t("retry")}
      </Button>
    </Alert>
  );
}

export function SlowNetworkNotice() {
  const t = useTranslations("Common");
  return (
    <p role="status" className="text-sm text-espresso-muted">
      {t("slowNetwork")}
    </p>
  );
}
