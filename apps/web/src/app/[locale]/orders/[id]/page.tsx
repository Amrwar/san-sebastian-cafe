import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Container, PageHeader, Surface } from "@ssc/ui";
import { ArrowLeftIcon } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { getOrderDetail, type OrderDetail } from "@/server/modules/ordering/customer-orders";
import { requireSessionUser } from "@/server/session";
import { Reorder } from "./Reorder.client";
import { Tracking } from "./Tracking.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/orders/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Orders" });
  return { title: t("title") };
}

export default async function OrderDetailPage({ params }: PageProps<"/[locale]/orders/[id]">) {
  const { locale, id } = await params;
  const user = await requireSessionUser(locale, `/${locale}/orders/${id}`);
  let order: OrderDetail;
  try {
    order = await getOrderDetail(db(), user, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }

  const [t, tCart, tStatus, tCommon, format] = await Promise.all([
    getTranslations("OrderDetail"),
    getTranslations("Cart"),
    getTranslations("OrderStatus"),
    getTranslations("Common"),
    getFormatter(),
  ]);
  const en = locale === "en";
  const totals = order.totals;
  const rows = [
    { label: tCart("subtotal"), cents: totals.subtotalCents },
    { label: tCart("discount"), cents: -totals.discountCents, hide: totals.discountCents === 0 },
    {
      label: tCart("reward"),
      cents: -totals.rewardDiscountCents,
      hide: totals.rewardDiscountCents === 0,
    },
    {
      label: tCart("deliveryFee"),
      cents: totals.deliveryFeeCents,
      hide: totals.deliveryFeeCents === 0,
    },
    { label: tCart("gst"), cents: totals.gstCents },
    { label: tCart("qst"), cents: totals.qstCents },
    { label: tCart("tip"), cents: totals.tipCents, hide: totals.tipCents === 0 },
  ];

  return (
    <Container className="max-w-3xl pb-10">
      <Link href="/orders" className="mt-6 inline-flex min-h-11 items-center gap-2 text-burgundy">
        <ArrowLeftIcon className="size-5" />
        {t("back")}
      </Link>
      <PageHeader title={t("title", { number: order.number })}>
        <p className="flex flex-wrap items-center gap-2 text-base">
          <Badge tone="brand">{tStatus(order.status)}</Badge>
          {order.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
          <span>
            {order.fulfilment === "pickup" ? t("pickup") : t("delivery")} ·{" "}
            {t("placedAt", {
              date: format.dateTime(order.placedAt, { dateStyle: "long", timeStyle: "short" }),
            })}
          </span>
        </p>
      </PageHeader>

      <div className="flex flex-col gap-6">
        <Surface>
          <Tracking orderId={order.id} number={order.number} initialStatus={order.status} />
        </Surface>

        <Surface className="flex flex-col gap-4">
          <h2 className="font-display text-2xl text-espresso">{t("itemsTitle")}</h2>
          <ul className="divide-y divide-line">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-4 py-3">
                <div>
                  <p className="font-semibold text-espresso">
                    {item.quantity} × {en ? item.productNameEn : item.productNameFr}
                  </p>
                  <p className="text-sm text-espresso-muted">
                    {[
                      en ? item.variantNameEn : item.variantNameFr,
                      ...item.modifiers.map((m) => (en ? m.nameEn : m.nameFr)),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p className="tabular-nums text-espresso">{money(item.lineTotalCents, locale)}</p>
              </li>
            ))}
          </ul>
          <Reorder
            items={order.items.map((i) => ({
              productId: i.productId,
              variantId: i.variantId,
              optionIds: i.modifiers.map((m) => m.optionId),
              quantity: i.quantity,
            }))}
          />
        </Surface>

        <Surface className="flex flex-col gap-3">
          <h2 className="font-display text-2xl text-espresso">{t("totalsTitle")}</h2>
          <dl className="flex flex-col gap-2">
            {rows
              .filter((r) => !r.hide)
              .map((r) => (
                <div key={r.label} className="flex justify-between gap-4 text-espresso-muted">
                  <dt>{r.label}</dt>
                  <dd className="tabular-nums">
                    {r.cents < 0 ? `−${money(-r.cents, locale)}` : money(r.cents, locale)}
                  </dd>
                </div>
              ))}
            <div className="mt-2 flex justify-between border-t border-line pt-3 text-lg font-semibold text-espresso">
              <dt>{tCart("total")}</dt>
              <dd className="tabular-nums">{money(totals.totalCents, locale)}</dd>
            </div>
          </dl>
          <p className="text-sm text-espresso-muted">{t("receiptNote")}</p>
        </Surface>
      </div>
    </Container>
  );
}
