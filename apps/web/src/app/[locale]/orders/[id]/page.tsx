import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, buttonClasses, Container, PageHeader, Surface } from "@ssc/ui";
import { ArrowLeftIcon } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { getOrderDetail, type OrderDetail } from "@/server/modules/ordering/customer-orders";
import { orderPaymentSummary } from "@/server/modules/payments/history";
import { getFulfilmentOptions } from "@/server/modules/store/pickup";
import { getSessionUser, requireSessionUser } from "@/server/session";
import { OrderActions } from "./OrderActions.client";
import { PaymentInfo } from "./PaymentInfo";
import { Reorder } from "./Reorder.client";
import { Tracking } from "./Tracking.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/orders/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Orders" });
  return { title: t("title"), robots: { index: false } };
}

/** Order detail + live tracking for the owner, staff, or a guest holding the order link. */
export default async function OrderDetailPage({
  params,
  searchParams,
}: PageProps<"/[locale]/orders/[id]">) {
  const { locale, id } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  const user = token
    ? await getSessionUser()
    : await requireSessionUser(locale, `/${locale}/orders/${id}`);

  let order: OrderDetail;
  try {
    order = await getOrderDetail(db(), user, id, token);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }

  const [t, tCart, tStatus, tCommon, format, fulfilment, payment] = await Promise.all([
    getTranslations("OrderDetail"),
    getTranslations("Cart"),
    getTranslations("OrderStatus"),
    getTranslations("Common"),
    getFormatter(),
    order.canModify ? getFulfilmentOptions(db()) : Promise.resolve(null),
    orderPaymentSummary(db(), order.id),
  ]);
  const en = locale === "en";
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
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
  const time = (d: Date) =>
    format.dateTime(d, { weekday: "short", hour: "numeric", minute: "2-digit" });

  return (
    <Container className="max-w-3xl pb-10">
      {user ? (
        <Link href="/orders" className="mt-6 inline-flex min-h-11 items-center gap-2 text-burgundy">
          <ArrowLeftIcon className="size-5" />
          {t("back")}
        </Link>
      ) : null}
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
        <p className="text-base">
          {order.scheduledFor
            ? t("scheduledFor", { time: time(order.scheduledFor) })
            : t("readyBy", { time: time(order.readyBy) })}
        </p>
        {token ? <p className="text-sm">{t("guestNotice")}</p> : null}
      </PageHeader>

      <div className="flex flex-col gap-6">
        {order.status === "awaiting_payment" ? (
          <Alert
            tone="warning"
            title={
              order.expiresAt
                ? t("awaitingPayment", {
                    time: format.dateTime(order.expiresAt, { hour: "numeric", minute: "2-digit" }),
                  })
                : undefined
            }
          >
            <Link
              href={`/checkout/pay/${order.id}${tokenQuery}`}
              className={buttonClasses("primary", "md", "mt-2")}
            >
              {t("payNow")}
            </Link>
          </Alert>
        ) : null}
        {order.status === "expired" ? <Alert tone="neutral">{t("expiredNotice")}</Alert> : null}
        {order.cancellationReason &&
        (order.status === "cancelled" ||
          order.status === "rejected" ||
          order.status === "refunded") ? (
          <Alert tone="neutral">{t("reason", { reason: order.cancellationReason })}</Alert>
        ) : null}

        {order.status !== "awaiting_payment" && order.status !== "expired" ? (
          <Surface>
            <Tracking
              orderId={order.id}
              number={order.number}
              initialStatus={order.status}
              token={token}
            />
          </Surface>
        ) : null}

        <OrderActions
          orderId={order.id}
          token={token}
          canCancel={order.canCancel}
          canModify={order.canModify}
          slots={fulfilment?.pickup.slots.map((s) => s.startsAt) ?? []}
        />

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
                  {item.notes ? (
                    <p className="text-sm italic text-espresso">
                      {t("itemNote", { note: item.notes })}
                    </p>
                  ) : null}
                </div>
                <p className="tabular-nums text-espresso">{money(item.lineTotalCents, locale)}</p>
              </li>
            ))}
          </ul>
          {order.notes ? (
            <p className="rounded-sm bg-ivory-sunken px-3 py-2 text-sm">
              <span className="font-semibold">{t("notesTitle")} :</span> {order.notes}
            </p>
          ) : null}
          {order.deliveryAddress ? (
            <p className="text-sm text-espresso-muted">
              {t("deliveryTo", {
                address: [
                  order.deliveryAddress.line1,
                  order.deliveryAddress.line2,
                  order.deliveryAddress.city,
                  order.deliveryAddress.postalCode,
                ]
                  .filter(Boolean)
                  .join(", "),
              })}
            </p>
          ) : null}
          {user ? (
            <Reorder
              items={order.items.map((i) => ({
                productId: i.productId,
                variantId: i.variantId,
                optionIds: i.modifiers.map((m) => m.optionId),
                quantity: i.quantity,
              }))}
            />
          ) : null}
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

        {order.status !== "awaiting_payment" || payment.state !== "unpaid" ? (
          <PaymentInfo
            summary={payment}
            locale={locale}
            receiptHref={`/orders/${order.id}/receipt${tokenQuery}`}
          />
        ) : null}
      </div>
    </Container>
  );
}
