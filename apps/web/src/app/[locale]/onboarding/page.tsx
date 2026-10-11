import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { SettingsForm } from "@/components/SettingsForm.client";
import { toDomainLocale } from "@/i18n/routing";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { db } from "@/server/db";
import { getAccountSettings } from "@/server/modules/identity/account-settings";
import { needsOnboarding } from "@/server/modules/identity/onboarding";
import { requireSessionUser } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/onboarding">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Onboarding" });
  return { title: t("title") };
}

/** First-run step after a new account's first sign-in: name, language and email choices. */
export default async function OnboardingPage({
  params,
  searchParams,
}: PageProps<"/[locale]/onboarding">) {
  const { locale } = await params;
  const sp = await searchParams;
  const next = safeRedirectPath(typeof sp.next === "string" ? sp.next : null, `/${locale}`);
  const user = await requireSessionUser(locale, `/${locale}/onboarding`);
  if (!(await needsOnboarding(db(), user))) redirect(next);

  const [t, settings] = await Promise.all([
    getTranslations("Onboarding"),
    getAccountSettings(db(), user),
  ]);
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <SettingsForm
        mode="onboarding"
        sections={["profile", "notifications"]}
        next={next}
        submitLabel={t("submit")}
        // New accounts default to the language they signed up in.
        initial={{ ...settings, preferredLocale: toDomainLocale(locale) }}
      />
    </Container>
  );
}
