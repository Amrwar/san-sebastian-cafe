import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Badge, buttonClasses, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listFavorites } from "@/server/modules/customer/favorites";
import { requireSessionUser } from "@/server/session";
import { FavoriteActions } from "./FavoriteActions.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/favorites">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Favorites" });
  return { title: t("title") };
}

export default async function FavoritesPage({ params }: PageProps<"/[locale]/favorites">) {
  const { locale } = await params;
  const user = await requireSessionUser(locale, `/${locale}/favorites`);
  const [t, tCommon, tMenu, favorites] = await Promise.all([
    getTranslations("Favorites"),
    getTranslations("Common"),
    getTranslations("Menu"),
    listFavorites(db(), user),
  ]);
  const en = locale === "en";

  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <AccountNav current="favorites" role={user.role} />

      {favorites.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          action={
            <Link href="/menu" className={buttonClasses("primary")}>
              {tMenu("title")}
            </Link>
          }
        >
          {t("emptyBody")}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {favorites.map((f) => {
            const name = en ? f.nameEn : f.nameFr;
            const details = [
              en ? f.variantNameEn : f.variantNameFr,
              ...(en ? f.optionNamesEn : f.optionNamesFr),
            ];
            return (
              <li key={f.id}>
                <Surface
                  as="article"
                  className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-espresso">
                      {f.slug ? (
                        <Link href={`/menu/${f.slug}`} className="hover:underline">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                      {f.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
                      {!f.orderable ? <Badge tone="danger">{t("unavailable")}</Badge> : null}
                    </h2>
                    <p className="text-sm text-espresso-muted">
                      {details.filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <FavoriteActions
                    id={f.id}
                    name={name}
                    productId={f.productId}
                    variantId={f.variantId}
                    optionIds={f.optionIds}
                    orderable={f.orderable}
                  />
                </Surface>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}
