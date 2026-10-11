import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { PaymentReturn } from "./PaymentReturn.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/return/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "PaymentReturn" });
  return { title: t("title"), robots: { index: false } };
}

/**
 * Where the payment provider sends the customer back. Nothing here marks the order paid: the
 * client asks the server, which checks with the provider (see PaymentReturn).
 */
export default async function PaymentReturnPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout/return/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  const t = await getTranslations("PaymentReturn");
  return (
    <Container className="max-w-xl pb-10">
      <PageHeader title={t("title")} />
      <PaymentReturn orderId={id} token={token} />
    </Container>
  );
}
