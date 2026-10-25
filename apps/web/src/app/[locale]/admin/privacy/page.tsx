import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader, Surface } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { listIncidents } from "@/server/modules/privacy/incidents";
import { getPrivacyOfficer } from "@/server/modules/privacy/officer";
import { listPrivacyRequests, RESPONSE_DAYS } from "@/server/modules/privacy/requests";
import { RETENTION } from "@/server/modules/privacy/retention";
import { requirePermissionForPage } from "@/server/session";
import { IncidentRegister } from "./IncidentRegister.client";
import { OfficerForm } from "./OfficerForm.client";
import { PrivacyRequests } from "./PrivacyRequests.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/privacy">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminPrivacy" });
  return { title: t("title"), robots: { index: false } };
}

/** Law 25 tools: privacy officer, privacy requests, incident register, retention (manager+). */
export default async function AdminPrivacyPage({ params }: PageProps<"/[locale]/admin/privacy">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/privacy`,
    "privacy:manage",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const [t, officer, requests, incidents] = await Promise.all([
    getTranslations("AdminPrivacy"),
    getPrivacyOfficer(db()),
    listPrivacyRequests(db(), user),
    listIncidents(db(), user),
  ]);

  return (
    <Container className="max-w-5xl pb-10">
      <PageHeader title={t("title")}>
        <p className="max-w-2xl text-espresso-muted">
          {t.rich("intro", {
            policy: (chunks) => (
              <Link href="/privacy" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </PageHeader>
      <AdminNav current="privacy" role={user.role} />

      <Surface className="mb-6 flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("officer.title")}</h2>
        <p className="text-sm text-espresso-muted">{t("officer.hint")}</p>
        <OfficerForm initial={officer} />
      </Surface>

      <Surface className="mb-6 flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("requests.title")}</h2>
        <p className="text-sm text-espresso-muted">{t("requests.hint", { days: RESPONSE_DAYS })}</p>
        <PrivacyRequests
          requests={requests.map((r) => ({
            ...r,
            receivedAt: r.receivedAt.toISOString(),
            dueAt: r.dueAt.toISOString(),
            completedAt: r.completedAt?.toISOString() ?? null,
          }))}
        />
      </Surface>

      <Surface className="mb-6 flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("incidents.title")}</h2>
        <p className="text-sm text-espresso-muted">{t("incidents.hint")}</p>
        <IncidentRegister
          incidents={incidents.map(({ createdAt, updatedAt, closedAt, ...i }) => ({
            ...i,
            recordedAt: createdAt.toISOString(),
            closedAt: closedAt?.toISOString() ?? null,
            updatedAt: updatedAt.toISOString(),
          }))}
        />
      </Surface>

      <Surface className="flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("retention.title")}</h2>
        <ul className="list-disc space-y-1 ps-5 text-sm text-espresso-muted">
          <li>{t("retention.guests", { days: RETENTION.guestContactDays })}</li>
          <li>{t("retention.webhooks", { days: RETENTION.paymentEventPayloadDays })}</li>
          <li>{t("retention.sessions")}</li>
          <li>{t("retention.books")}</li>
        </ul>
        <p className="text-sm text-espresso-muted">
          {env().CRON_SECRET ? t("retention.scheduled") : t("retention.notScheduled")}
        </p>
      </Surface>
    </Container>
  );
}
