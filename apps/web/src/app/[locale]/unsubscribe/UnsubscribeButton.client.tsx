"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button } from "@ssc/ui";
import { apiFetch } from "@/lib/api-client";

export function UnsubscribeButton({ userId, token }: { userId: string; token: string }) {
  const t = useTranslations("Unsubscribe");
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");

  if (state === "done") return <Alert tone="success">{t("done")}</Alert>;
  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        className="self-start"
        pending={state === "pending"}
        disabled={state === "pending"}
        onClick={() => {
          setState("pending");
          apiFetch(
            `/api/v1/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`,
            { method: "POST" },
          )
            .then(() => {
              setState("done");
            })
            .catch(() => {
              setState("error");
            });
        }}
      >
        {t("confirm")}
      </Button>
      <div aria-live="polite">
        {state === "error" ? <Alert tone="danger">{t("error")}</Alert> : null}
      </div>
    </div>
  );
}
