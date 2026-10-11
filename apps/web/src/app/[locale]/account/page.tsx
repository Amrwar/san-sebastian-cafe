import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { SettingsForm } from "@/components/SettingsForm.client";
import { SignOutButton } from "@/components/SignOutButton.client";
import { db } from "@/server/db";
import { getAccountSettings } from "@/server/modules/identity/account-settings";
import { requireSessionUser } from "@/server/session";
import { signOut } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/account">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Account" });
  return { title: t("eyebrow") };
}

export default async function AccountPage({ params }: PageProps<"/[locale]/account">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/account`);
  const [t, tRoles, settings] = await Promise.all([
    getTranslations("Account"),
    getTranslations("Roles"),
    getAccountSettings(db(), user),
  ]);

  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title", { name: settings.name || "empty" })}>
        <p>{t("signedInAs", { email: settings.email })}</p>
        {user.role !== "customer" ? (
          <p className="text-base">{t("role", { role: tRoles(user.role) })}</p>
        ) : null}
      </PageHeader>
      <AccountNav current="profile" role={user.role} />

      <SettingsForm sections={["profile"]} initial={settings} />

      <form action={signOut} className="mt-10 border-t border-line pt-6">
        <input type="hidden" name="locale" value={locale} />
        <SignOutButton label={t("signOut")} />
      </form>
    </Container>
  );
}
