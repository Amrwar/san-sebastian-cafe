import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { money } from "@/lib/format";
import { db } from "@/server/db";
import { listActivePromotions } from "@/server/modules/promotions/public";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/promotions">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Promotions" });
  return { title: t("title") };
}

/** Promotions that are active right now, straight from the database. */
export default async function PromotionsPage({ params }: PageProps<"/[locale]/promotions">) {
  const { locale } = await params;
  const [t, tCommon, format, promotions] = await Promise.all([
    getTranslations("Promotions"),
    getTranslations("Common"),
    getFormatter(),
    listActivePromotions(db()),
  ]);
  const en = locale === "en";

  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      {promotions.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>{t("emptyBody")}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {promotions.map((p) => (
            <li key={p.id}>
              <Surface as="article" className="flex flex-col gap-2">
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-espresso">
                  {en ? p.nameEn : p.nameFr}
                  {p.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                </h2>
                <p className="font-display text-2xl text-burgundy">
                  {p.kind === "percent_off"
                    ? t("percentOff", { value: p.value / 100 })
                    : t("amountOff", { value: money(p.value, locale) })}
                </p>
                <p className="font-mono text-sm text-espresso">
                  {p.code ? t("code", { code: p.code }) : t("noCode")}
                </p>
                <ul className="text-sm text-espresso-muted">
                  {p.minSubtotalCents > 0 ? (
                    <li>{t("minSubtotal", { amount: money(p.minSubtotalCents, locale) })}</li>
                  ) : null}
                  {p.endsAt ? (
                    <li>
                      {t("endsOn", { date: format.dateTime(p.endsAt, { dateStyle: "long" }) })}
                    </li>
                  ) : null}
                  {!p.stackableWithRewards ? <li>{t("notStackable")}</li> : null}
                </ul>
              </Surface>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
