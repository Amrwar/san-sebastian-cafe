import Image from "next/image";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, ProductArt } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { money, pick } from "@/lib/format";
import type { MenuProduct } from "@/server/modules/catalog/menu";

/** Menu card. Uses the owner's photo when one exists; otherwise a labelled illustration. */
export async function ProductCard({
  product,
  headingLevel = 3,
}: {
  product: MenuProduct;
  headingLevel?: 2 | 3;
}) {
  const [t, tCommon, locale] = await Promise.all([
    getTranslations("Menu"),
    getTranslations("Common"),
    getLocale(),
  ]);
  const name = pick(product, "name", locale);
  const soldOut = product.availability === "sold_out";
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-md border border-line bg-ivory-raised shadow-soft transition-shadow hover:shadow-md has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-burgundy">
      {product.imageUrl ? (
        <Image
          src={product.imageUrl}
          alt={pick(product, "imageAlt", locale)}
          width={640}
          height={480}
          className="aspect-[4/3] w-full object-cover"
        />
      ) : (
        <ProductArt
          kind={product.isDrink ? "drink" : "food"}
          caption={tCommon("photoComingSoon")}
        />
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap gap-1.5">
          {product.isDemo ? <Badge tone="warning">{tCommon("demo")}</Badge> : null}
          {product.unavailableReason === "outside_hours" ||
          product.unavailableReason === "temporarily_unavailable" ? (
            <Badge tone="warning">{t(`badges.${product.unavailableReason}`)}</Badge>
          ) : soldOut ? (
            <Badge tone="danger">{t("soldOut")}</Badge>
          ) : null}
        </div>
        <Heading className="text-lg font-semibold leading-snug text-espresso">
          {/* The whole card is clickable through this link's ::after overlay. */}
          <Link
            href={`/menu/${product.slug}`}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {name}
          </Link>
        </Heading>
        {product.fromPriceCents !== null ? (
          <p
            className={
              soldOut ? "mt-auto text-espresso-muted" : "mt-auto font-semibold text-espresso"
            }
          >
            {t("from", { price: money(product.fromPriceCents, locale) })}
          </p>
        ) : null}
      </div>
    </article>
  );
}
