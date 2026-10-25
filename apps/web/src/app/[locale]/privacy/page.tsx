import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { LegalText } from "@/components/LegalText";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getPrivacyOfficer } from "@/server/modules/privacy/officer";
import { RESPONSE_DAYS } from "@/server/modules/privacy/requests";
import { RETENTION } from "@/server/modules/privacy/retention";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/privacy">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Privacy" });
  return { title: t("title") };
}

export const dynamic = "force-dynamic";

const SECTIONS = [
  "controller",
  "collected",
  "purposes",
  "consent",
  "sharing",
  "location",
  "retention",
  "rights",
  "security",
  "incidents",
  "changes",
] as const;

/** What the app stores in the browser. Everything is needed for the site to work: no tracking. */
const COOKIES = [
  { name: "ssc.session_token", kind: "cookie", purpose: "session", duration: "days30" },
  { name: "NEXT_LOCALE", kind: "cookie", purpose: "language", duration: "session" },
  { name: "ssc_welcomed", kind: "cookie", purpose: "welcome", duration: "year" },
  { name: "ssc.cart.v1", kind: "storage", purpose: "cart", duration: "untilCleared" },
  { name: "ssc.cart-extras.v1", kind: "storage", purpose: "cartExtras", duration: "untilCleared" },
] as const;

/**
 * Privacy policy (Law 25). The text is a DRAFT written from what the platform actually does; the
 * café's lawyer must review it before launch. The privacy officer comes from the admin settings.
 */
export default async function PrivacyPage() {
  const [t, officer] = await Promise.all([getTranslations("Privacy"), getPrivacyOfficer(db())]);
  const values = {
    officer: officer.name ?? t("officerMissing"),
    officerEmail: officer.email ?? t("officerMissing"),
    responseDays: RESPONSE_DAYS,
    guestDays: RETENTION.guestContactDays,
    webhookDays: RETENTION.paymentEventPayloadDays,
  };

  return (
    <Container className="max-w-3xl pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("updated")}</p>
      </PageHeader>
      <Alert tone="warning" className="mb-6">
        {t("draft")}
      </Alert>

      <Surface className="mb-6 flex flex-col gap-2">
        <h2 className="font-display text-2xl text-espresso">{t("officer.title")}</h2>
        <LegalText text={t("officer.body", values)} />
        {officer.email ? (
          <p>
            <a href={`mailto:${officer.email}`} className="font-semibold text-burgundy underline">
              {officer.email}
            </a>
          </p>
        ) : null}
      </Surface>

      <div className="flex flex-col gap-8 text-espresso [&_p]:leading-relaxed">
        {SECTIONS.map((key) => (
          <section key={key} className="flex flex-col gap-3" aria-labelledby={`privacy-${key}`}>
            <h2 id={`privacy-${key}`} className="font-display text-2xl">
              {t(`sections.${key}.title`)}
            </h2>
            <LegalText text={t(`sections.${key}.body`, values)} />
            {key === "rights" ? (
              <p>
                {t.rich("rightsSelfService", {
                  link: (chunks) => (
                    <Link href="/account/data" className="underline underline-offset-4">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : null}
          </section>
        ))}

        <section className="flex flex-col gap-3" aria-labelledby="privacy-cookies">
          <h2 id="privacy-cookies" className="font-display text-2xl">
            {t("cookies.title")}
          </h2>
          <p>{t("cookies.body")}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-espresso-muted">
                  <th scope="col" className="py-2 pe-4 font-semibold">
                    {t("cookies.name")}
                  </th>
                  <th scope="col" className="py-2 pe-4 font-semibold">
                    {t("cookies.purpose")}
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    {t("cookies.duration")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {COOKIES.map((c) => (
                  <tr key={c.name}>
                    <th scope="row" className="py-2 pe-4 align-top font-normal">
                      <code className="text-xs">{c.name}</code>
                      <span className="block text-xs text-espresso-muted">
                        {t(`cookies.kinds.${c.kind}`)}
                      </span>
                    </th>
                    <td className="py-2 pe-4 align-top">{t(`cookies.purposes.${c.purpose}`)}</td>
                    <td className="py-2 align-top">{t(`cookies.durations.${c.duration}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Container>
  );
}
