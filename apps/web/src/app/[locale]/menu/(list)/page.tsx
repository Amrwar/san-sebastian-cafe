import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, buttonClasses, cn, Container, EmptyState, PageHeader } from "@ssc/ui";
import { SearchIcon } from "@/components/icons";
import { ProductCard } from "@/components/ProductCard";
import { Link } from "@/i18n/navigation";
import { pick } from "@/lib/format";
import { db } from "@/server/db";
import { listCategories, searchMenu } from "@/server/modules/catalog/storefront";

export async function generateMetadata({ params }: PageProps<"/[locale]/menu">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Menu" });
  return { title: t("title") };
}

export default async function MenuPage({ params, searchParams }: PageProps<"/[locale]/menu">) {
  const { locale } = await params;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const category = typeof sp.category === "string" ? sp.category.slice(0, 80) : "";

  const [t, categories, menu] = await Promise.all([
    getTranslations("Menu"),
    listCategories(db()),
    searchMenu(db(), { q, category: category || undefined }),
  ]);
  const hasDemo = menu.some((c) => c.isDemo || c.products.some((p) => p.isDemo));
  const resultCount = menu.reduce((n, c) => n + c.products.length, 0);
  const menuHref = (slug: string, keepQuery: boolean) => {
    const params = new URLSearchParams();
    if (keepQuery && q) params.set("q", q);
    if (slug) params.set("category", slug);
    const query = params.toString();
    return query ? `/menu?${query}` : "/menu";
  };

  return (
    <Container>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>

      {/* Plain GET form: search works without JavaScript and results are shareable URLs. */}
      <form role="search" action={`/${locale}/menu`} className="mb-6 flex gap-2">
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <label htmlFor="menu-search" className="sr-only">
          {t("searchLabel")}
        </label>
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-espresso-muted" />
          <input
            id="menu-search"
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t("searchPlaceholder")}
            enterKeyHint="search"
            maxLength={80}
            className="block min-h-11 w-full rounded-pill border border-line-strong bg-ivory-raised ps-11 pe-4 text-base text-espresso placeholder:text-espresso-muted/70 focus-visible:border-burgundy"
          />
        </div>
        <button type="submit" className={buttonClasses("primary")}>
          {t("searchSubmit")}
        </button>
      </form>

      <nav aria-label={t("categoriesLabel")} className="-mx-4 mb-8 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1">
          {[
            { slug: "", nameFr: t("allCategories"), nameEn: t("allCategories") },
            ...categories,
          ].map((c) => {
            const active = c.slug === category;
            return (
              <li key={c.slug || "all"} className="shrink-0">
                <Link
                  href={menuHref(c.slug, true)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-pill border px-4 text-[0.95rem] transition-colors",
                    active
                      ? "border-burgundy bg-burgundy text-ivory"
                      : "border-line-strong bg-ivory-raised text-espresso hover:border-espresso-muted",
                  )}
                >
                  {pick(c, "name", locale)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {q ? (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <p role="status" className="text-espresso-muted">
            {t("resultsCount", { count: resultCount })}
          </p>
          <Link
            href={menuHref(category, false)}
            className="text-burgundy underline underline-offset-4"
          >
            {t("clearSearch")}
          </Link>
        </div>
      ) : null}

      {hasDemo ? (
        <Alert tone="warning" className="mb-8" role="note">
          {t("demoNotice")}
        </Alert>
      ) : null}

      {menu.length === 0 ? (
        q ? (
          <EmptyState title={t("noResultsTitle")}>{t("noResultsBody", { q })}</EmptyState>
        ) : (
          <EmptyState title={t("emptyTitle")}>{t("emptyBody")}</EmptyState>
        )
      ) : (
        <div className="flex flex-col gap-12">
          {menu.map((c) => (
            <section key={c.id} aria-labelledby={`cat-${c.slug}`}>
              <h2 id={`cat-${c.slug}`} className="mb-4 font-display text-3xl text-espresso">
                {pick(c, "name", locale)}
              </h2>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {c.products.map((p) => (
                  <li key={p.id}>
                    <ProductCard product={p} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}
