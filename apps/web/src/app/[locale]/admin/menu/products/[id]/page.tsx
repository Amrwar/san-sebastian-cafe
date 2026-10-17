import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, buttonClasses, Container, PageHeader } from "@ssc/ui";
import { AdminNav } from "@/components/AdminNav";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  getAdminProduct,
  listAdminMenu,
  listModifierGroups,
  type AdminProduct,
} from "@/server/modules/admin/menu";
import { requirePermissionForPage } from "@/server/session";
import { ProductForm } from "../ProductForm.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/menu/products/[id]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMenu" });
  return { title: t("title"), robots: { index: false } };
}

/** Create (`/new`) or edit a product. */
export default async function AdminProductPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/menu/products/[id]">) {
  const { locale, id } = await params;
  const sp = await searchParams;
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/admin/menu/products/${id}`,
    "catalog:manage",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;

  const isNew = id === "new";
  const [t, menu, groups, product] = await Promise.all([
    getTranslations("AdminProduct"),
    listAdminMenu(db(), user),
    listModifierGroups(db(), user),
    isNew
      ? Promise.resolve(null)
      : getAdminProduct(db(), user, id).catch((e: unknown): AdminProduct | null => {
          if (e instanceof AppError && e.code === "not_found") return null;
          throw e;
        }),
  ]);
  if (!isNew && !product) notFound();

  const categories = menu.map((c) => ({ id: c.id, nameFr: c.nameFr, nameEn: c.nameEn }));
  const requested = typeof sp.category === "string" ? sp.category : "";
  const defaultCategoryId = categories.some((c) => c.id === requested)
    ? requested
    : (categories[0]?.id ?? "");
  const title = product
    ? t("editTitle", { name: locale === "fr" ? product.nameFr : product.nameEn })
    : t("newTitle");

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={title} />
      <AdminNav current="menu" role={user.role} />
      <div className="mb-6 flex flex-wrap gap-2">
        <Link href="/admin/menu" className={buttonClasses("secondary")}>
          {t("back")}
        </Link>
        {product && product.availability !== "hidden" ? (
          <Link href={`/menu/${product.slug}`} className={buttonClasses("ghost")}>
            {t("viewOnMenu")}
          </Link>
        ) : null}
      </div>
      {sp.created ? (
        <Alert tone="success" className="mb-6">
          {t("created")}
        </Alert>
      ) : null}
      <ProductForm
        key={product?.id ?? "new"}
        product={product}
        categories={categories}
        groups={groups}
        defaultCategoryId={defaultCategoryId}
      />
    </Container>
  );
}
