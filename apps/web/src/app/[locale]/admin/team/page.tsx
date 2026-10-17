import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader, Surface } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { listTeam } from "@/server/modules/admin/team";
import { requirePermissionForPage } from "@/server/session";
import { InviteForm, MemberRow } from "./TeamBoard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/team">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminTeam" });
  return { title: t("title"), robots: { index: false } };
}

/** Staff accounts and their roles (owner only). */
export default async function AdminTeamPage({ params }: PageProps<"/[locale]/admin/team">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(locale, `/${locale}/admin/team`, "staff:manage");
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const [t, team] = await Promise.all([getTranslations("AdminTeam"), listTeam(db(), user)]);

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AdminNav current="team" role={user.role} />
      <div className="flex flex-col gap-6">
        <InviteForm />
        <Surface className="flex flex-col">
          <h2 className="font-display text-2xl text-espresso">{t("membersTitle")}</h2>
          <ul className="divide-y divide-line">
            {team.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                isSelf={member.userId === user.userId}
              />
            ))}
          </ul>
        </Surface>
      </div>
    </Container>
  );
}
