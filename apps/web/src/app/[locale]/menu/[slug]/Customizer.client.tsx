"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultSelection, unitPriceCents, validateSelection, type Selection } from "@ssc/domain";
import { Alert, Button, ChoiceChip, ChoiceGroup, QuantityStepper } from "@ssc/ui";
import type { CatalogProduct } from "@ssc/db";
import { HeartIcon } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { money, pick } from "@/lib/format";

type Notice = {
  tone: "success" | "danger" | "neutral";
  text: string;
  link?: "cart" | "signIn";
} | null;

function initialState(product: CatalogProduct, editLineId: string | null) {
  const line = editLineId ? cart.get(editLineId) : undefined;
  if (line && line.productId === product.id) {
    return {
      selection: { variantId: line.variantId, optionIds: line.optionIds },
      quantity: line.quantity,
      editing: true,
    };
  }
  return { selection: defaultSelection(product), quantity: 1, editing: false };
}

/**
 * Builds the size/option form from the product's menu configuration. The price shown is an
 * estimate from the same domain function the server uses; the cart re-prices on the server.
 */
export function Customizer({
  product,
  signedIn,
  editLineId,
}: {
  product: CatalogProduct;
  signedIn: boolean;
  editLineId: string | null;
}) {
  const t = useTranslations("Product");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const formId = useId();
  const [{ selection, quantity, editing }, setState] = useState(() =>
    initialState(product, editLineId),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);

  const issues = validateSelection(product, selection, quantity);
  const groupIssue = (groupId: string) => issues.find((i) => i.ref === groupId);
  const soldOut = product.availability !== "available";
  const unit = unitPriceCents(product, selection);
  const name = pick(product, "name", locale);

  const update = (next: Partial<Selection>) => {
    setState((s) => ({ ...s, selection: { ...s.selection, ...next } }));
    setNotice(null);
  };

  const toggleOption = (groupId: string, optionId: string, single: boolean) => {
    const group = product.groups.find((g) => g.id === groupId);
    if (!group) return;
    const inGroup = new Set(group.options.map((o) => o.id));
    const others = selection.optionIds.filter((id) => !inGroup.has(id));
    const current = selection.optionIds.filter((id) => inGroup.has(id));
    const next = single
      ? [optionId]
      : current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
    update({ optionIds: [...others, ...next] });
  };

  const submit = () => {
    if (issues.length > 0) {
      setShowErrors(true);
      setNotice({ tone: "danger", text: t("fixChoices") });
      return;
    }
    const item = {
      productId: product.id,
      variantId: selection.variantId,
      optionIds: selection.optionIds,
      quantity,
    };
    if (editing && editLineId) cart.replace(editLineId, item);
    else cart.add(item);
    setNotice({ tone: "success", text: editing ? t("updated") : t("added"), link: "cart" });
  };

  const saveFavorite = async () => {
    if (!signedIn) {
      setNotice({ tone: "neutral", text: t("favoriteSignIn"), link: "signIn" });
      return;
    }
    setSavingFavorite(true);
    try {
      await apiFetch("/api/v1/me/favorites", {
        method: "POST",
        body: JSON.stringify({
          productId: product.id,
          variantId: selection.variantId,
          optionIds: selection.optionIds,
        }),
      });
      setNotice({ tone: "success", text: t("favoriteSaved") });
    } catch (error) {
      const signInNeeded = error instanceof ApiError && error.failure.kind === "unauthenticated";
      setNotice(
        signInNeeded
          ? { tone: "neutral", text: t("favoriteSignIn"), link: "signIn" }
          : { tone: "danger", text: t("favoriteError") },
      );
    } finally {
      setSavingFavorite(false);
    }
  };

  if (soldOut) {
    return (
      <Alert tone="warning" title={t("soldOutTitle")}>
        {t("soldOutBody")}
      </Alert>
    );
  }

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-8"
    >
      {product.variants.length > 1 ? (
        <ChoiceGroup legend={t("sizeLegend")} hint={t("required")}>
          {product.variants.map((v) => {
            const unavailable = v.availability !== "available";
            return (
              <ChoiceChip
                key={v.id}
                type="radio"
                name="variant"
                value={v.id}
                checked={selection.variantId === v.id}
                disabled={unavailable}
                onChange={() => {
                  update({ variantId: v.id });
                }}
                label={pick(v, "name", locale)}
                detail={money(v.priceCents, locale)}
                unavailableLabel={t("soldOutOption")}
              />
            );
          })}
        </ChoiceGroup>
      ) : null}

      {product.groups.map((g) => {
        const single = g.selection === "single";
        const chosen = selection.optionIds.filter((id) => g.options.some((o) => o.id === id));
        const atMax = !single && chosen.length >= g.maxSelected;
        const issue = showErrors ? groupIssue(g.id) : undefined;
        const hint =
          g.minSelected > 0
            ? t("required")
            : single
              ? undefined
              : t("optionalUpTo", { max: g.maxSelected });
        return (
          <ChoiceGroup
            key={g.id}
            legend={pick(g, "name", locale)}
            hint={hint}
            error={
              issue?.code === "group_below_minimum"
                ? t("groupMin", { min: g.minSelected })
                : issue?.code === "group_above_maximum"
                  ? t("groupMax", { max: g.maxSelected })
                  : undefined
            }
          >
            {g.options.map((o) => {
              const checked = chosen.includes(o.id);
              const unavailable = o.availability !== "available";
              return (
                <ChoiceChip
                  key={o.id}
                  type={single ? "radio" : "checkbox"}
                  name={`group-${g.id}`}
                  value={o.id}
                  checked={checked}
                  disabled={unavailable || (atMax && !checked)}
                  onChange={() => {
                    toggleOption(g.id, o.id, single);
                  }}
                  label={pick(o, "name", locale)}
                  detail={
                    o.priceDeltaCents > 0
                      ? t("priceDelta", { price: money(o.priceDeltaCents, locale) })
                      : undefined
                  }
                  unavailableLabel={unavailable ? t("soldOutOption") : undefined}
                />
              );
            })}
          </ChoiceGroup>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-lg font-semibold text-espresso" aria-hidden="true">
            {t("quantity")}
          </span>
          <QuantityStepper
            value={quantity}
            onChange={(q) => {
              setState((s) => ({ ...s, quantity: q }));
            }}
            label={t("quantityFor", { name })}
            decreaseLabel={t("decrease")}
            increaseLabel={t("increase")}
          />
        </div>
        <Button variant="secondary" onClick={() => void saveFavorite()} pending={savingFavorite}>
          <HeartIcon className="size-5" />
          {t("saveFavorite")}
        </Button>
      </div>

      <div aria-live="polite">
        {notice ? (
          <Alert tone={notice.tone}>
            {notice.text}{" "}
            {notice.link === "cart" ? (
              <Link href="/cart" className="font-semibold underline underline-offset-4">
                {t("viewCart")}
              </Link>
            ) : notice.link === "signIn" ? (
              <Link
                href={`/sign-in?next=${encodeURIComponent(`/${locale}/menu/${product.slug}`)}`}
                className="font-semibold underline underline-offset-4"
              >
                {tCommon("signIn")}
              </Link>
            ) : null}
          </Alert>
        ) : null}
      </div>

      {/* Sticky action bar, kept above the mobile tab bar. */}
      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 -mx-4 border-t border-line bg-ivory/95 px-4 py-3 backdrop-blur md:bottom-4 md:mx-0 md:rounded-md md:border md:shadow-soft">
        <Button type="submit" size="lg" className="w-full">
          {editing
            ? t("update", { price: money(unit * quantity, locale) })
            : t("add", { price: money(unit * quantity, locale) })}
        </Button>
        <p className="mt-2 text-center text-xs text-espresso-muted">{t("estimate")}</p>
      </div>
    </form>
  );
}
