import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { productAt } from "@ssc/domain";
import { Alert, Badge, Container, ProductArt } from "@ssc/ui";
import { ArrowLeftIcon } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { pick } from "@/lib/format";
import { formatWindows } from "@/lib/format-hours";
import { db } from "@/server/db";
import { getProductBySlug } from "@/server/modules/catalog/storefront";
import { getSessionUser } from "@/server/session";
import { Customizer } from "./Customizer.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/menu/[slug]">): Promise<Metadata> {
  const { locale, slug } = await params;
  const product = await getProductBySlug(db(), slug);
  return { title: product ? pick(product, "name", locale) : undefined };
}

export default async function ProductPage({
  params,
  searchParams,
}: PageProps<"/[locale]/menu/[slug]">) {
  const { locale, slug } = await params;
  const sp = await searchParams;
  const [product, user, t, tCommon] = await Promise.all([
    getProductBySlug(db(), slug),
    getSessionUser(),
    getTranslations("Product"),
    getTranslations("Common"),
  ]);
  if (!product) notFound();
  // Schedules and staff pauses are evaluated now; the cart re-checks them at the pickup time.
  const now = new Date();
  const effective = productAt(product, now);
  const format = await getFormatter();
  const hours = product.availabilityWindows?.length
    ? formatWindows(product.availabilityWindows, locale)
    : null;

  const name = pick(product, "name", locale);
  const description = pick(product, "description", locale);
  const allergens = pick(product, "allergenNote", locale);
  const editLineId = typeof sp.edit === "string" ? sp.edit.slice(0, 64) : null;

  return (
    <Container className="pb-10">
      <Link href="/menu" className="mt-6 inline-flex min-h-11 items-center gap-2 text-burgundy">
        <ArrowLeftIcon className="size-5" />
        {t("back")}
      </Link>

      <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-start">
        <div className="flex flex-col gap-5 lg:sticky lg:top-24">
          <div className="overflow-hidden rounded-md">
            {product.imageUrl ? (
              <Image
                src={product.imageUrl}
                alt={pick(product, "imageAlt", locale)}
                width={960}
                height={720}
                priority
                className="aspect-[4/3] w-full object-cover"
              />
            ) : (
              <ProductArt
                kind={product.isDrink ? "drink" : "food"}
                caption={tCommon("photoComingSoon")}
              />
            )}
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-burgundy">
              {pick(product.category, "name", locale)}
            </p>
            <h1 className="font-display text-4xl leading-tight text-espresso sm:text-5xl">
              {name}
            </h1>
            {product.isDemo ? (
              <Badge tone="warning" className="self-start">
                {tCommon("demo")}
              </Badge>
            ) : null}
            {description ? (
              <p className="text-lg leading-relaxed text-espresso-muted">{description}</p>
            ) : null}
          </div>
          <Alert tone="neutral" title={t("allergensTitle")} role="note">
            {allergens || t("allergensMissing")}
          </Alert>
        </div>

        <div className="flex flex-col gap-4">
          {effective.unavailableReason === "outside_hours" ? (
            <Alert tone="warning" title={t("outsideHours")}>
              {hours ? t("availableHours", { hours }) : null}
            </Alert>
          ) : effective.unavailableReason === "temporarily_unavailable" &&
            product.unavailableUntil ? (
            <Alert tone="warning" title={t("soldOutTitle")}>
              {t("temporarilyUnavailable", {
                time: format.dateTime(product.unavailableUntil, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </Alert>
          ) : effective.unavailableReason ? (
            <Alert tone="warning" title={t("soldOutTitle")}>
              {t("soldOutBody")}
            </Alert>
          ) : (
            <>
              {hours ? (
                <p className="text-sm text-espresso-muted">{t("availableHours", { hours })}</p>
              ) : null}
              <Customizer product={effective} signedIn={Boolean(user)} editLineId={editLineId} />
            </>
          )}
        </div>
      </div>
    </Container>
  );
}
