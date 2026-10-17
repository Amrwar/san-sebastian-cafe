"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";
import type { LoyaltyCustomerMatch } from "@/server/modules/loyalty/staff";

/**
 * Looks a customer up by exact email or code. The search runs as a POST so the email never ends
 * up in a URL (history, logs); the page then opens the card by the customer's opaque id.
 */
export function CustomerSearch() {
  const t = useTranslations("StaffLoyalty");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const search = async () => {
    setPending(true);
    setMessage(null);
    try {
      const { match } = await apiFetch<{ match: LoyaltyCustomerMatch | null }>(
        "/api/v1/staff/loyalty/lookup",
        { method: "POST", body: JSON.stringify({ query: query.trim() }) },
      );
      if (match) router.push(`/staff/loyalty?customer=${encodeURIComponent(match.userId)}`);
      else setMessage(t("notFound"));
    } catch {
      setMessage(t("errors.generic"));
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
        void search();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("query")}
          name="query"
          type="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={320}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
          }}
        />
        <Button type="submit" pending={pending} disabled={pending || !query.trim()}>
          {t("search")}
        </Button>
      </div>
      <div aria-live="polite">{message ? <Alert tone="neutral">{message}</Alert> : null}</div>
    </form>
  );
}
