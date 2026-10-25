import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Badge, Container, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { PushToggle } from "@/components/PushToggle.client";
import { SettingsForm } from "@/components/SettingsForm.client";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { getAccountSettings } from "@/server/modules/identity/account-settings";
import { requireSessionUser } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/account/notifications">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Notifications" });
  return { title: t("title") };
}

export default async function NotificationsPage({
  params,
}: PageProps<"/[locale]/account/notifications">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/account/notifications`);
  const [t, tCommon, tPush, settings] = await Promise.all([
    getTranslations("Notifications"),
    getTranslations("Common"),
    getTranslations("Push"),
    getAccountSettings(db(), user),
  ]);
  const pushKey = env().VAPID_PUBLIC_KEY ?? null;

  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AccountNav current="notifications" role={user.role} />

      <SettingsForm sections={["notifications"]} initial={settings} />

      {/* Channels that don't exist yet are shown as unavailable, never as working switches. */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {pushKey ? (
          <Surface className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-espresso">{tPush("title")}</h2>
            <p className="text-sm text-espresso-muted">{tPush("body")}</p>
            <PushToggle publicKey={pushKey} />
          </Surface>
        ) : null}
        {[
          ...(pushKey ? [] : [{ title: t("pushTitle"), body: t("pushBody") }]),
          { title: t("smsTitle"), body: t("smsBody") },
        ].map((c) => (
          <Surface
            key={c.title}
            className="flex flex-col gap-2 border-dashed bg-ivory-sunken shadow-none"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-espresso">{c.title}</h2>
              <Badge>{tCommon("notAvailableYet")}</Badge>
            </div>
            <p className="text-sm text-espresso-muted">{c.body}</p>
          </Surface>
        ))}
      </div>
    </Container>
  );
}
