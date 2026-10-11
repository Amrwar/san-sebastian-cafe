import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { env } from "@/server/env";
import { getSessionUser } from "@/server/session";
import { SignInForm } from "./SignInForm.client";

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/[locale]/sign-in">): Promise<Metadata> {
  const { locale } = await params;
  const register = (await searchParams).mode === "register";
  const t = await getTranslations({ locale, namespace: "SignIn" });
  return { title: register ? t("registerTitle") : t("title") };
}

/**
 * Sign-in and registration share one passwordless flow (an account is created on first sign-in);
 * `?mode=register` only changes the wording for people who are new.
 */
export default async function SignInPage({ params, searchParams }: PageProps<"/[locale]/sign-in">) {
  const { locale } = await params;
  const sp = await searchParams;
  const t = await getTranslations("SignIn");
  const register = sp.mode === "register";
  const destination = safeRedirectPath(
    typeof sp.next === "string" ? sp.next : null,
    `/${locale}/account`,
  );
  const nextQuery = typeof sp.next === "string" ? `&next=${encodeURIComponent(destination)}` : "";

  if (await getSessionUser()) redirect(destination);

  // The console email transport is only permitted outside staging/production.
  const devMode = env().APP_ENV === "development" || env().APP_ENV === "test";

  return (
    <Container className="max-w-xl">
      <PageHeader eyebrow={t("eyebrow")} title={register ? t("registerTitle") : t("title")}>
        <p>{register ? t("registerIntro") : t("intro")}</p>
      </PageHeader>
      <Surface>
        <SignInForm destination={destination} />
      </Surface>
      <div className="mt-6 flex flex-col gap-2">
        <Link
          href={
            register ? `/sign-in?mode=signin${nextQuery}` : `/sign-in?mode=register${nextQuery}`
          }
          className="text-burgundy underline underline-offset-4"
        >
          {register ? t("switchToSignIn") : t("switchToRegister")}
        </Link>
        <Link href="/sign-in/help" className="text-burgundy underline underline-offset-4">
          {t("help")}
        </Link>
      </div>
      {devMode ? (
        <Alert tone="warning" className="mt-6" role="note">
          {t("devHint")}
        </Alert>
      ) : null}
    </Container>
  );
}
