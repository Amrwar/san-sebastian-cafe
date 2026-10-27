import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader, Surface } from "@ssc/ui";
import { env } from "@/server/env";
import { getSessionUser } from "@/server/session";
import { BalanceCheck } from "./BalanceCheck.client";
import { BuyCard } from "./BuyCard.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/gift-cards">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "GiftCards" });
  return { title: t("title") };
}

/**
 * Gift cards: bought here (code emailed to the recipient) or at the counter, used at checkout or
 * at the counter. This page sells them, checks a balance and states the rules (Québec: no expiry,
 * no fees).
 */
export default async function GiftCardsPage() {
  const [t, user] = await Promise.all([getTranslations("GiftCards"), getSessionUser()]);
  return (
    <Container className="max-w-2xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <div className="flex flex-col gap-6">
        <BuyCard signedIn={user !== null} paymentsEnabled={env().PAYMENT_PROVIDER !== "none"} />
        <BalanceCheck />
        <Surface className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-espresso">{t("howTitle")}</h2>
          <ul className="list-disc ps-5 text-espresso-muted">
            <li>{t("howBuy")}</li>
            <li>{t("howUse")}</li>
          </ul>
        </Surface>
        <Surface className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-espresso">{t("policyTitle")}</h2>
          <p className="text-espresso-muted">{t("policyBody")}</p>
        </Surface>
      </div>
    </Container>
  );
}
