"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, buttonClasses } from "@ssc/ui";
import { TrashIcon } from "@/components/icons";
import { Link, useRouter } from "@/i18n/navigation";
import { apiFetch } from "@/lib/api-client";
import { cart } from "@/lib/cart";

/** Add-to-cart (re-priced in the cart) and remove actions for one saved favourite. */
export function FavoriteActions({
  id,
  name,
  productId,
  variantId,
  optionIds,
  orderable,
}: {
  id: string;
  name: string;
  productId: string;
  variantId: string;
  optionIds: string[];
  orderable: boolean;
}) {
  const t = useTranslations("Favorites");
  const tCommon = useTranslations("Common");
  const tProduct = useTranslations("Product");
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!orderable}
          onClick={() => {
            cart.add({ productId, variantId, optionIds, quantity: 1 });
            setMessage({ ok: true, text: t("added", { name }) });
          }}
        >
          {t("addToCart")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          pending={removing}
          aria-label={t("removeLabel", { name })}
          onClick={() => {
            setRemoving(true);
            apiFetch(`/api/v1/me/favorites/${id}`, { method: "DELETE" })
              .then(() => {
                router.refresh();
              })
              .catch(() => {
                setMessage({ ok: false, text: t("error") });
                setRemoving(false);
              });
          }}
        >
          <TrashIcon className="size-4" />
          {tCommon("remove")}
        </Button>
      </div>
      <p
        aria-live="polite"
        className={message?.ok ? "text-sm text-success" : "text-sm text-danger"}
      >
        {message?.text}{" "}
        {message?.ok ? (
          <Link href="/cart" className={buttonClasses("ghost", "sm", "underline")}>
            {tProduct("viewCart")}
          </Link>
        ) : null}
      </p>
    </div>
  );
}
