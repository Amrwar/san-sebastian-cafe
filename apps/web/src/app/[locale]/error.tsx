"use client";

import { useTranslations } from "next-intl";
import { Button, Container, PageHeader } from "@ssc/ui";

/** Route-level error boundary. Shows the error digest so support can correlate with server logs. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Errors");
  return (
    <Container className="max-w-2xl">
      <PageHeader title={t("errorTitle")}>
        <p>{t("errorBody")}</p>
        {error.digest ? (
          <p className="mt-2 font-mono text-sm">{t("reference", { id: error.digest })}</p>
        ) : null}
      </PageHeader>
      <Button onClick={reset}>{t("retry")}</Button>
    </Container>
  );
}
