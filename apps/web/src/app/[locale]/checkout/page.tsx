import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { getFulfilmentOptions } from "@/server/modules/store/pickup";
import { getSessionUser } from "@/server/session";
import { Checkout } from "./Checkout.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Checkout" });
  return { title: t("title") };
}

export default async function CheckoutPage() {
  const [t, user, options] = await Promise.all([
    getTranslations("Checkout"),
    getSessionUser(),
    getFulfilmentOptions(db()),
  ]);
  return (
    <Container className="pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} />
      <Checkout
        pickup={options.pickup}
        deliveryOffered={options.deliveryOffered}
        usesDemoHours={options.usesDemoHours}
        paymentsEnabled={env().PAYMENT_PROVIDER !== "none"}
        signedInEmail={user?.email ?? null}
        signedInName={user?.name ?? null}
      />
    </Container>
  );
}
