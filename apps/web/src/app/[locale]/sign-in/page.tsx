import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { env } from "@/server/env";
import { getSessionUser } from "@/server/session";
import { SignInForm } from "./SignInForm";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/sign-in">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "SignIn" });
  return { title: t("title") };
}

export default async function SignInPage({ params, searchParams }: PageProps<"/[locale]/sign-in">) {
  const { locale } = await params;
  const t = await getTranslations("SignIn");
  const next = (await searchParams).next;
  const destination = safeRedirectPath(
    typeof next === "string" ? next : null,
    `/${locale}/account`,
  );

  if (await getSessionUser()) redirect(destination);

  // The console email transport is only permitted outside staging/production.
  const devMode = env().APP_ENV === "development" || env().APP_ENV === "test";

  return (
    <Container className="max-w-xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <Surface>
        <SignInForm destination={destination} />
      </Surface>
      {devMode ? (
        <Alert tone="warning" className="mt-6" role="note">
          {t("devHint")}
        </Alert>
      ) : null}
    </Container>
  );
}
