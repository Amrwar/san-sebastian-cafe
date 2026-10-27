import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { syncPurchase } from "@/server/modules/gift-cards/purchases";
import { getSessionUser } from "@/server/session";
import { PurchaseStatus } from "./PurchaseStatus.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/gift-cards/purchase/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "GiftCards.purchase" });
  return { title: t("title"), robots: { index: false } };
}

/**
 * Where the payment page sends the purchaser back. The status comes from the provider (asked
 * directly), never from the redirect itself.
 */
export default async function GiftCardPurchasePage({
  params,
  searchParams,
}: PageProps<"/[locale]/gift-cards/purchase/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  let purchase;
  try {
    purchase = await syncPurchase(db(), await getSessionUser(), id, token);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }
  const t = await getTranslations("GiftCards.purchase");
  return (
    <Container className="max-w-2xl">
      <PageHeader title={t("title")} />
      <PurchaseStatus
        initial={purchase}
        token={token}
        cancelled={sp.cancelled === "1"}
        simulator={env().PAYMENT_PROVIDER === "fake" && purchase.provider === "fake"}
      />
    </Container>
  );
}
