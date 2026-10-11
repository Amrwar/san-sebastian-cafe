import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, Container, PageHeader, Surface } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { db } from "@/server/db";
import { countOrdersByStatus } from "@/server/modules/ordering/order-summary";
import { requirePermissionForPage } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Staff" });
  return { title: t("title") };
}

export default async function StaffPage({ params }: PageProps<"/[locale]/staff">) {
  const { locale } = await params;
  const access = await requirePermissionForPage(locale, `/${locale}/staff`, "staff_console:access");
  if (access.status === "forbidden") return <Forbidden />;

  const [t, tStatus, counts] = await Promise.all([
    getTranslations("Staff"),
    getTranslations("OrderStatus"),
    countOrdersByStatus(db(), access.user),
  ]);

  return (
    <Container>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Alert tone="neutral" title={t("queueTitle")} role="note">
          {t("queueBody")}
        </Alert>

        <Surface>
          <h2 className="font-display text-2xl text-espresso">{t("ordersByStatus")}</h2>
          <table className="mt-4 w-full text-left">
            <thead>
              <tr className="border-b border-line text-sm text-espresso-muted">
                <th scope="col" className="py-2 font-semibold">
                  {t("status")}
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  {t("count")}
                </th>
              </tr>
            </thead>
            <tbody>
              {counts.map((row) => (
                <tr key={row.status} className="border-b border-line/60 last:border-0">
                  <th scope="row" className="py-2.5 font-normal">
                    {tStatus(row.status)}
                  </th>
                  <td className="py-2.5 text-right tabular-nums">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      </div>
    </Container>
  );
}
