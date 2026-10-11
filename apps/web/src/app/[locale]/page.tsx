import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, EmptyState } from "@ssc/ui";
import { ProductCard } from "@/components/ProductCard";
import { StampCard } from "@/components/StampCard";
import { Link } from "@/i18n/navigation";
import { pick } from "@/lib/format";
import { WELCOMED_COOKIE } from "@/lib/welcome";
import { db } from "@/server/db";
import { getFeaturedProducts, listCategories } from "@/server/modules/catalog/storefront";
import { getLoyaltySummary } from "@/server/modules/loyalty/summary";
import { findActiveOrder } from "@/server/modules/ordering/customer-orders";
import { getSessionUser } from "@/server/session";

export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  const user = await getSessionUser();
  const [t, tStatus, featured, categories, activeOrder, loyalty, cookieStore] = await Promise.all([
    getTranslations("Home"),
    getTranslations("OrderStatus"),
    getFeaturedProducts(db()),
    listCategories(db()),
    findActiveOrder(db(), user),
    user ? getLoyaltySummary(db(), user) : Promise.resolve(null),
    cookies(),
  ]);
  const firstVisit = !user && !cookieStore.has(WELCOMED_COOKIE);

  return (
    <>
      <section className="on-dark bg-espresso text-ivory">
        <Container className="flex flex-col gap-5 pb-12 pt-10 sm:pb-16 sm:pt-14">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-crema">
            {t("eyebrow")}
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-balance sm:text-6xl">
            {user?.name ? t("greeting", { name: user.name }) : t("title")}
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-ivory/85">{t("intro")}</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/menu" className={buttonClasses("accent", "lg")}>
              {t("viewMenu")}
            </Link>
            {user ? null : (
              <Link href="/sign-in" className={buttonClasses("inverse", "lg")}>
                {t("signIn")}
              </Link>
            )}
          </div>
        </Container>
      </section>

      <Container className="flex flex-col gap-12 py-10">
        {activeOrder ? (
          <Link
            href={`/orders/${activeOrder.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-burgundy/30 bg-burgundy-tint px-5 py-4 text-burgundy"
          >
            <span className="font-semibold">
              {t("activeOrder", {
                number: activeOrder.number,
                status: tStatus(activeOrder.status),
              })}
            </span>
            <span className="underline underline-offset-4">{t("trackOrder")}</span>
          </Link>
        ) : null}

        {firstVisit ? (
          <section className="flex flex-col gap-3 rounded-md border border-line bg-ivory-raised p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-2xl text-espresso">{t("newHereTitle")}</h2>
              <p className="text-espresso-muted">{t("newHereBody")}</p>
            </div>
            <Link href="/welcome" className={buttonClasses("primary")}>
              {t("newHereCta")}
            </Link>
          </section>
        ) : null}

        <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
          <section aria-labelledby="featured-title">
            <div className="mb-5 flex items-baseline justify-between gap-4">
              <h2 id="featured-title" className="font-display text-3xl text-espresso">
                {t("featuredTitle")}
              </h2>
              <Link href="/menu" className="text-burgundy underline underline-offset-4">
                {t("seeMenu")}
              </Link>
            </div>
            {featured.length === 0 ? (
              <EmptyState title={t("featuredEmpty")} />
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {featured.map((p) => (
                  <li key={p.id}>
                    <ProductCard product={p} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="flex flex-col gap-8">
            {loyalty ? (
              <section aria-labelledby="card-title" className="flex flex-col gap-3">
                <h2 id="card-title" className="font-display text-2xl text-espresso">
                  {t("rewardsTitle")}
                </h2>
                <StampCard count={loyalty.stampBalance} total={loyalty.stampsPerReward} compact />
                {loyalty.availableRewards.length > 0 ? (
                  <p className="font-semibold text-burgundy">
                    {t("rewardsReady", { count: loyalty.availableRewards.length })}
                  </p>
                ) : null}
                <Link href="/rewards" className="text-burgundy underline underline-offset-4">
                  {t("viewRewards")}
                </Link>
              </section>
            ) : null}

            {categories.length > 0 ? (
              <section aria-labelledby="categories-title">
                <h2 id="categories-title" className="mb-3 font-display text-2xl text-espresso">
                  {t("categoriesTitle")}
                </h2>
                <ul className="flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <li key={c.slug}>
                      <Link
                        href={`/menu?category=${encodeURIComponent(c.slug)}`}
                        className="inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-ivory-raised px-4 text-espresso hover:border-espresso-muted"
                      >
                        {pick(c, "name", locale)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        </div>
      </Container>
    </>
  );
}
