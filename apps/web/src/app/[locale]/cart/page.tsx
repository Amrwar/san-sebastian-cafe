import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@ssc/ui";
import { getSessionUser } from "@/server/session";
import { Cart } from "./Cart.client";

export async function generateMetadata({ params }: PageProps<"/[locale]/cart">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Cart" });
  return { title: t("title") };
}

export default async function CartPage() {
  const [t, user] = await Promise.all([getTranslations("Cart"), getSessionUser()]);
  return (
    <Container className="pb-10">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} />
      <Cart signedIn={Boolean(user)} />
    </Container>
  );
}
