"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, CheckboxField, QuantityStepper, SelectField, TextField } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";
import type { InStoreCatalogProduct, InStoreCustomer } from "@/server/modules/loyalty/in-store";

interface Line {
  key: number;
  productId: string;
  variantId: string;
  quantity: number;
}

interface VisitResult {
  stampsEarned: number;
  rewardsIssued: number;
  rewardUsed: boolean;
  stampBalance: number;
}

/** The business reason of a refused request, for the message catalog. */
function reasonOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const f = error.failure;
  if (f.kind === "forbidden") return "forbidden";
  return "reason" in f ? f.reason : null;
}

/**
 * Counter purchase: identify the customer by the code on their phone, enter the receipt, record
 * the stamps. The server decides what earns; this form only says what was bought.
 */
export function CounterVisit({ catalog }: { catalog: InStoreCatalogProduct[] }) {
  const t = useTranslations("StaffLoyalty");
  const locale = useLocale();
  const name = (o: { nameFr: string; nameEn: string }) => (locale === "fr" ? o.nameFr : o.nameEn);
  const first = catalog[0];
  const newLine = (key: number): Line => ({
    key,
    productId: first?.id ?? "",
    variantId: first?.variants[0]?.id ?? "",
    quantity: 1,
  });

  const [code, setCode] = useState("");
  const [customer, setCustomer] = useState<InStoreCustomer | null>(null);
  const [receipt, setReceipt] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(0)]);
  const [useReward, setUseReward] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ receipt?: string }>({});
  const [result, setResult] = useState<VisitResult | null>(null);
  // One key per attempt: a retried submit after a timeout can't stamp twice.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  const errorText = (r: string | null) =>
    r && t.has(`errors.${r}`) ? t(`errors.${r}` as "errors.generic") : t("errors.generic");

  const reset = () => {
    setCode("");
    setCustomer(null);
    setReceipt("");
    setLines([newLine(0)]);
    setUseReward(false);
    setError(null);
    setFieldErrors({});
    setResult(null);
    setAttemptKey(crypto.randomUUID());
  };

  const find = async () => {
    setPending(true);
    setError(null);
    try {
      const found = await apiFetch<{ counter: InStoreCustomer | null }>(
        "/api/v1/staff/loyalty/lookup",
        { method: "POST", body: JSON.stringify({ query: code.trim() }) },
      );
      if (found.counter) setCustomer(found.counter);
      else setError(t("errors.card_code_invalid"));
    } catch (e) {
      setError(errorText(reasonOf(e)));
    } finally {
      setPending(false);
    }
  };

  const record = async () => {
    if (!customer) return;
    if (!receipt.trim()) {
      setFieldErrors({ receipt: t("errors.receipt") });
      return;
    }
    setFieldErrors({});
    setPending(true);
    setError(null);
    try {
      setResult(
        await apiFetch<VisitResult>("/api/v1/staff/loyalty/visits", {
          method: "POST",
          body: JSON.stringify({
            code: customer.code,
            receiptReference: receipt.trim(),
            items: lines.map(({ productId, variantId, quantity }) => ({
              productId,
              variantId,
              quantity,
            })),
            useReward,
            idempotencyKey: attemptKey,
          }),
        }),
      );
    } catch (e) {
      const r = reasonOf(e);
      setError(errorText(r));
      // A refused request (not a lost one) may be corrected and sent again as a new attempt.
      if (r) setAttemptKey(crypto.randomUUID());
    } finally {
      setPending(false);
    }
  };

  const update = (key: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  if (result) {
    return (
      <div className="flex flex-col items-start gap-3" aria-live="polite">
        <Alert tone="success">
          {t("recorded", { stamps: result.stampsEarned, balance: result.stampBalance })}
          {result.rewardUsed ? ` ${t("recordedReward")}` : ""}
          {result.rewardsIssued > 0 ? ` ${t("recordedNewReward")}` : ""}
        </Alert>
        <Button onClick={reset}>{t("newCustomer")}</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!customer ? (
        <form
          noValidate
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <TextField
            label={t("code")}
            name="code"
            value={code}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={20}
            onChange={(e) => {
              setCode(e.currentTarget.value);
            }}
          />
          <Button type="submit" pending={pending} disabled={pending || !code.trim()}>
            {t("find")}
          </Button>
        </form>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
        >
          <p className="rounded-md bg-ivory-sunken px-4 py-3 font-semibold text-espresso">
            {t("customerCard", {
              name: customer.firstName,
              balance: customer.stampBalance,
              total: customer.stampsPerReward,
              rewards: customer.availableRewards,
            })}
            {customer.stampDebt > 0 ? ` · ${t("owes", { count: customer.stampDebt })}` : ""}
          </p>
          <TextField
            label={t("receipt")}
            hint={t("receiptHint")}
            name="receipt"
            value={receipt}
            autoComplete="off"
            maxLength={40}
            error={fieldErrors.receipt}
            onChange={(e) => {
              setReceipt(e.currentTarget.value);
            }}
          />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold text-espresso">{t("items")}</legend>
            {lines.map((line, index) => {
              const product = catalog.find((p) => p.id === line.productId);
              return (
                <div
                  key={line.key}
                  className="flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
                >
                  <SelectField
                    label={t("product")}
                    value={line.productId}
                    onChange={(e) => {
                      const next = catalog.find((p) => p.id === e.currentTarget.value);
                      update(line.key, {
                        productId: e.currentTarget.value,
                        variantId: next?.variants[0]?.id ?? "",
                      });
                    }}
                  >
                    {catalog.map((p) => (
                      <option key={p.id} value={p.id}>
                        {name(p)}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label={t("size")}
                    value={line.variantId}
                    onChange={(e) => {
                      update(line.key, { variantId: e.currentTarget.value });
                    }}
                  >
                    {product?.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {name(v)} · {money(v.priceCents, locale)}
                      </option>
                    ))}
                  </SelectField>
                  <QuantityStepper
                    value={line.quantity}
                    onChange={(quantity) => {
                      update(line.key, { quantity });
                    }}
                    label={`${t("quantity")}, ${product ? name(product) : ""}`}
                    decreaseLabel={t("decrease")}
                    increaseLabel={t("increase")}
                  />
                  {lines.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setLines((ls) => ls.filter((l) => l.key !== line.key));
                      }}
                      aria-label={`${t("remove")} ${index + 1}`}
                    >
                      {t("remove")}
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {lines.length < 30 ? (
              <Button
                type="button"
                variant="secondary"
                className="self-start"
                onClick={() => {
                  setLines((ls) => [...ls, newLine((ls.at(-1)?.key ?? 0) + 1)]);
                }}
              >
                {t("addItem")}
              </Button>
            ) : null}
          </fieldset>
          {customer.availableRewards > 0 ? (
            <CheckboxField
              label={t("useReward")}
              hint={t("useRewardHint")}
              checked={useReward}
              onChange={(e) => {
                setUseReward(e.currentTarget.checked);
              }}
            />
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" pending={pending} disabled={pending}>
              {t("record")}
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
      <div aria-live="polite">{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    </div>
  );
}
