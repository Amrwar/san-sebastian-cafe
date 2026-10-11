import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cents, formatCad } from "@ssc/domain";
import { Alert, Badge, Container, EmptyState, PageHeader } from "@ssc/ui";
import { toDomainLocale } from "@/i18n/routing";
import { db } from "@/server/db";
import { getPublishedMenu } from "@/server/modules/catalog/menu";

export async function generateMetadata({ params }: PageProps<"/[locale]/menu">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Menu" });
  return { title: t("title") };
}

export default async function MenuPage({ params }: PageProps<"/[locale]/menu">) {
  const { locale } = await params;
  const t = await getTranslations("Menu");
  const tCommon = await getTranslations("Common");
  const domainLocale = toDomainLocale(locale);
  const fr = domainLocale === "fr-CA";

  const menu = await getPublishedMenu(db());
  const hasDemo = menu.some((c) => c.isDemo || c.products.some((p) => p.isDemo));

  return (
    <Container>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>

      {hasDemo ? (
        <Alert tone="warning" className="mb-10" role="note">
          {t("demoNotice")}
        </Alert>
      ) : null}

      {menu.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>{t("emptyBody")}</EmptyState>
      ) : (
        <div className="flex flex-col gap-14">
          {menu.map((category) => (
            <section key={category.id} aria-labelledby={`cat-${category.slug}`}>
              <h2
                id={`cat-${category.slug}`}
                className="border-b border-line pb-3 font-display text-3xl text-espresso"
              >
                {fr ? category.nameFr : category.nameEn}
              </h2>
              <ul className="divide-y divide-line">
                {category.products.map((product) => {
                  const soldOut = product.availability === "sold_out";
                  return (
                    <li
                      key={product.id}
                      className="flex flex-col gap-2 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
                    >
                      <div className="flex max-w-2xl flex-col gap-1.5">
                        <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-espresso">
                          {fr ? product.nameFr : product.nameEn}
                          {product.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                          {soldOut ? <Badge tone="danger">{t("soldOut")}</Badge> : null}
                        </h3>
                        {(fr ? product.descriptionFr : product.descriptionEn) ? (
                          <p className="text-espresso-muted">
                            {fr ? product.descriptionFr : product.descriptionEn}
                          </p>
                        ) : null}
                        <p className="text-sm text-espresso-muted">
                          {t("options", { count: product.modifierGroupCount })}
                        </p>
                      </div>
                      {product.fromPriceCents !== null ? (
                        <p
                          className={
                            soldOut
                              ? "shrink-0 text-espresso-muted line-through"
                              : "shrink-0 font-semibold text-espresso"
                          }
                        >
                          {t("from", {
                            price: formatCad(cents(product.fromPriceCents), domainLocale),
                          })}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}
