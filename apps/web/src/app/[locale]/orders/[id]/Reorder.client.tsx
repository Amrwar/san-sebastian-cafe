"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { cart } from "@/lib/cart";

/**
 * Adds the order's items to the cart with their original configuration. The cart then re-prices
 * them at today's prices and flags anything no longer available — nothing is charged here.
 */
export function Reorder({
  items,
}: {
  items: Array<{ productId: string; variantId: string; optionIds: string[]; quantity: number }>;
}) {
  const t = useTranslations("Orders");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="secondary"
      pending={pending}
      onClick={() => {
        setPending(true);
        for (const item of items) cart.add(item);
        router.push("/cart");
      }}
    >
      {t("reorder")}
    </Button>
  );
}
