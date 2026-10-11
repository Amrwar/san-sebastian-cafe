import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, buttonClasses, Container, EmptyState, PageHeader } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { ACTIVE_STATUSES, listMyOrders } from "@/server/modules/ordering/customer-orders";
import { requireSessionUser } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/orders">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Orders" });
  return { title: t("title") };
}

export default async function OrdersPage({ params }: PageProps<"/[locale]/orders">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/orders`);
  const [t, tStatus, tCommon, tMenu, format, orders] = await Promise.all([
    getTranslations("Orders"),
    getTranslations("OrderStatus"),
    getTranslations("Common"),
    getTranslations("Menu"),
    getFormatter(),
    listMyOrders(db(), user),
  ]);

  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} />
      <AccountNav current="orders" role={user.role} />

      {orders.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          action={
            <Link href="/menu" className={buttonClasses("primary")}>
              {tMenu("title")}
            </Link>
          }
        >
          {t("emptyBody")}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((o) => {
            const active = ACTIVE_STATUSES.includes(o.status);
            return (
              <li key={o.id}>
                <Link
                  href={`/orders/${o.id}`}
                  aria-label={t("view", { number: o.number })}
                  className="flex flex-col gap-2 rounded-md border border-line bg-ivory-raised p-5 shadow-soft transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2 text-lg font-semibold text-espresso">
                      {o.number}
                      <Badge
                        tone={active ? "brand" : o.status === "completed" ? "success" : "neutral"}
                      >
                        {tStatus(o.status)}
                      </Badge>
                      {o.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                    </p>
                    <p className="text-sm text-espresso-muted">
                      {format.dateTime(o.placedAt, { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                      {t("items", { count: o.itemCount })}
                    </p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums text-espresso">
                    {money(o.totalCents, locale)}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}
