import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Container } from "@ssc/ui";
import { Welcome } from "./Welcome.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/welcome">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Welcome" });
  return { title: t("eyebrow") };
}

export default function WelcomePage() {
  return (
    <Container>
      <Welcome />
    </Container>
  );
}
