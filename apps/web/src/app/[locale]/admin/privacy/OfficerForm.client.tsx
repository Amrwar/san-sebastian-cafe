"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

export function OfficerForm({
  initial,
}: {
  initial: { name: string | null; email: string | null };
}) {
  const t = useTranslations("AdminPrivacy.officer");
  const tMenu = useTranslations("AdminMenu");
  const router = useRouter();
  const [name, setName] = useState(initial.name ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setMessage(null);
        apiFetch("/api/v1/admin/privacy/officer", {
          method: "PUT",
          body: JSON.stringify({ name, email }),
        })
          .then(() => {
            setMessage({ ok: true, text: t("saved") });
            router.refresh();
          })
          .catch((err: unknown) => {
            const f = err instanceof ApiError ? err.failure : null;
            setMessage({
              ok: false,
              text: f?.kind === "validation" ? t("invalid") : tMenu("errors.generic"),
            });
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t("name")}
          hint={t("nameHint")}
          value={name}
          maxLength={120}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <TextField
          label={t("email")}
          type="email"
          value={email}
          maxLength={254}
          onChange={(e) => {
            setEmail(e.currentTarget.value);
          }}
        />
      </div>
      <Button
        type="submit"
        variant="secondary"
        pending={pending}
        disabled={pending}
        className="self-start"
      >
        {t("save")}
      </Button>
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </form>
  );
}
