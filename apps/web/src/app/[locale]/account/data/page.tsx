import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getAccountSettings } from "@/server/modules/identity/account-settings";
import { requireSessionUser } from "@/server/session";
import { DeleteAccount } from "./DeleteAccount.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/account/data">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AccountData" });
  return { title: t("title"), robots: { index: false } };
}

/** A customer's own data: download a copy, or delete the account (Law 25). */
export default async function AccountDataPage({ params }: PageProps<"/[locale]/account/data">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/account/data`);
  const [t, settings] = await Promise.all([
    getTranslations("AccountData"),
    getAccountSettings(db(), user),
  ]);

  return (
    <Container className="max-w-3xl pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>
          {t.rich("intro", {
            policy: (chunks) => (
              <Link href="/privacy" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </PageHeader>
      <AccountNav current="data" role={user.role} />

      <Surface className="mb-6 flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("export.title")}</h2>
        <p className="text-espresso-muted">{t("export.body")}</p>
        <ul className="list-disc ps-5 text-sm text-espresso-muted">
          {(["account", "orders", "loyalty", "preferences", "signIns"] as const).map((k) => (
            <li key={k}>{t(`export.includes.${k}`)}</li>
          ))}
        </ul>
        {/* A plain link: the browser downloads the file. */}
        <a
          href="/api/v1/me/data"
          download
          className={buttonClasses("secondary", "md", "self-start")}
        >
          {t("export.button")}
        </a>
      </Surface>

      <Surface className="flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("delete.title")}</h2>
        {user.role === "customer" ? (
          <>
            <p className="text-espresso-muted">{t("delete.body")}</p>
            <ul className="list-disc ps-5 text-sm text-espresso-muted">
              <li>{t("delete.removed")}</li>
              <li>{t("delete.kept")}</li>
              <li>{t("delete.final")}</li>
            </ul>
            <DeleteAccount email={settings.email} />
          </>
        ) : (
          <p className="text-espresso-muted">{t("delete.staff")}</p>
        )}
      </Surface>
    </Container>
  );
}
