import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, Container, PageHeader, Surface } from "@ssc/ui";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { getOrderDetail, type OrderDetail } from "@/server/modules/ordering/customer-orders";
import { paymentView } from "@/server/modules/payments/checkout";
import { getSessionUser } from "@/server/session";
import { PaySimulator } from "./PaySimulator.client";
import { PayWithProvider } from "./PayWithProvider.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/pay/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Pay" });
  return { title: t("eyebrow"), robots: { index: false } };
}

/** Payment step for an order awaiting payment (owner or guest token). */
export default async function PayPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout/pay/[id]">) {
  const { locale, id } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";

  let order: OrderDetail;
  try {
    order = await getOrderDetail(db(), await getSessionUser(), id, token);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }
  // Paid, cancelled or expired orders have nothing to pay: show the order instead.
  if (order.status !== "awaiting_payment") redirect(`/${locale}/orders/${order.id}${tokenQuery}`);

  const [t, tCommon, tOrders, format] = await Promise.all([
    getTranslations("Pay"),
    getTranslations("Common"),
    getTranslations("Orders"),
    getFormatter(),
  ]);
  const items = order.items.reduce((n, i) => n + i.quantity, 0);
  const { PAYMENT_PROVIDER, STRIPE_SECRET_KEY } = env();
  const payment = await paymentView(db(), order.id);
  const testMode = PAYMENT_PROVIDER === "stripe" && !STRIPE_SECRET_KEY?.includes("_live_");

  return (
    <Container className="max-w-xl pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title", { number: order.number })}>
        {order.expiresAt ? (
          <p>
            {t("heldUntil", {
              time: format.dateTime(order.expiresAt, { hour: "numeric", minute: "2-digit" }),
            })}
          </p>
        ) : null}
      </PageHeader>
      <div className="flex flex-col gap-6">
        <Surface className="flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-espresso">
              {order.number} {order.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
            </p>
            <p className="text-sm text-espresso-muted">{tOrders("items", { count: items })}</p>
          </div>
          <p className="font-display text-3xl tabular-nums text-espresso">
            {money(order.totals.totalCents, locale)}
          </p>
        </Surface>
        {sp.cancelled ? <Alert tone="neutral">{t("cancelled")}</Alert> : null}
        {payment.state === "processing" ? (
          <Alert tone="brand">{t("processingNotice")}</Alert>
        ) : PAYMENT_PROVIDER === "stripe" ? (
          <Surface className="flex flex-col gap-4">
            <div>
              <h2 className="font-display text-2xl text-espresso">{t("stripeTitle")}</h2>
              <p className="mt-1 text-espresso-muted">{t("stripeBody")}</p>
            </div>
            <PayWithProvider
              orderId={order.id}
              token={token}
              amountLabel={money(order.totals.totalCents, locale)}
            />
            {testMode ? <p className="text-sm text-warning">{t("testMode")}</p> : null}
          </Surface>
        ) : PAYMENT_PROVIDER === "fake" ? (
          <PaySimulator orderId={order.id} token={token} />
        ) : (
          <Alert tone="brand" role="note">
            {t("unavailable")}
          </Alert>
        )}
      </div>
    </Container>
  );
}
