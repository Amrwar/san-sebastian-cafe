import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { env } from "@/server/env";
import { validUnsubscribeToken } from "@/server/modules/marketing/campaigns";
import { UnsubscribeButton } from "./UnsubscribeButton.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/unsubscribe">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Unsubscribe" });
  return { title: t("title"), robots: { index: false } };
}

/**
 * From the link in a marketing email. Opening the page changes nothing (mail scanners open links);
 * the button does, at once. No sign-in needed: the link is signed.
 */
export default async function UnsubscribePage({
  searchParams,
}: PageProps<"/[locale]/unsubscribe">) {
  const sp = await searchParams;
  const u = typeof sp.u === "string" ? sp.u : "";
  const token = typeof sp.t === "string" ? sp.t : "";
  const t = await getTranslations("Unsubscribe");
  const valid = u !== "" && validUnsubscribeToken(u, token, env().BETTER_AUTH_SECRET);

  return (
    <Container className="max-w-2xl pb-10">
      <PageHeader title={t("title")} />
      <Surface className="flex flex-col gap-4">
        {valid ? (
          <>
            <p>{t("body")}</p>
            <UnsubscribeButton userId={u} token={token} />
          </>
        ) : (
          <Alert tone="danger">{t("invalid")}</Alert>
        )}
        <p className="text-sm text-espresso-muted">
          {t.rich("manage", {
            link: (chunks) => (
              <Link href="/account/notifications" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </Surface>
    </Container>
  );
}
