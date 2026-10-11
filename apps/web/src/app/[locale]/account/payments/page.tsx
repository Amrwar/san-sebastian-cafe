import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { customerPaymentHistory } from "@/server/modules/payments/history";
import { requireSessionUser } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/account/payments">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "PaymentHistory" });
  return { title: t("title"), robots: { index: false } };
}

/** The signed-in customer's payments and refunds (display-only card details). */
export default async function PaymentHistoryPage({
  params,
}: PageProps<"/[locale]/account/payments">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/account/payments`);
  const [t, format, entries] = await Promise.all([
    getTranslations("PaymentHistory"),
    getFormatter(),
    customerPaymentHistory(db(), user),
  ]);

  return (
    <Container className="max-w-3xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AccountNav current="payments" role={user.role} />
      {entries.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Surface className="p-0">
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li
                key={`${e.kind}-${e.orderId}-${e.at}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              >
                <div>
                  <p className="font-semibold text-espresso">
                    {e.kind === "payment" ? t("payment") : t("refund")}{" "}
                    <Badge tone={e.kind === "refund" ? "neutral" : "brand"}>
                      {t(`status.${e.status}`)}
                    </Badge>
                  </p>
                  <p className="text-sm text-espresso-muted">
                    <Link href={`/orders/${e.orderId}`} className="underline underline-offset-4">
                      {t("order", { number: e.orderNumber })}
                    </Link>{" "}
                    · {format.dateTime(new Date(e.at), { dateStyle: "medium", timeStyle: "short" })}
                    {e.cardBrand && e.cardLast4 ? ` · ${e.cardBrand} •••• ${e.cardLast4}` : ""}
                  </p>
                </div>
                <p className="font-semibold tabular-nums text-espresso">
                  {e.kind === "refund" ? "−" : ""}
                  {money(e.amountCents, locale)}
                </p>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </Container>
  );
}
