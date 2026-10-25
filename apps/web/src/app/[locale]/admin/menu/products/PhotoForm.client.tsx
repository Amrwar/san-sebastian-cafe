"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, ProductArt, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

/** Same limits as the server (src/server/modules/admin/product-photo.ts). */
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/** A product's photo with its required French and English alt text. */
export function PhotoForm({
  product,
}: {
  product: {
    id: string;
    isDrink: boolean;
    imageUrl: string | null;
    imageAltFr: string | null;
    imageAltEn: string | null;
  };
}) {
  const t = useTranslations("AdminProduct.photo");
  const tMenu = useTranslations("AdminMenu");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const locale = useLocale();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Remounts the file input to clear it after a save.
  const [inputKey, setInputKey] = useState(0);
  const [altFr, setAltFr] = useState(product.imageAltFr ?? "");
  const [altEn, setAltEn] = useState(product.imageAltEn ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Frees each preview's object URL once it is replaced or the form unmounts.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const pick = (picked: File | null) => {
    setFile(picked);
    setPreview(picked ? URL.createObjectURL(picked) : null);
  };

  const fileError = (f: File | null) =>
    !f
      ? product.imageUrl
        ? undefined
        : t("errors.required")
      : !TYPES.includes(f.type)
        ? t("errors.type")
        : f.size > MAX_BYTES
          ? t("errors.tooLarge")
          : undefined;

  const failure = (e: unknown) => {
    const f = e instanceof ApiError ? e.failure : null;
    return f?.kind === "forbidden"
      ? tMenu("errors.forbidden")
      : f?.kind === "validation" && f.fields.includes("file")
        ? t("errors.file")
        : f?.kind === "validation"
          ? tMenu("errors.validation")
          : f?.kind === "unprocessable" && f.reason === "storage_unavailable"
            ? t("errors.storage")
            : tMenu("errors.generic");
  };

  const save = async () => {
    const next: Record<string, string> = {};
    const bad = fileError(file);
    if (bad) next.file = bad;
    if (!altFr.trim()) next.altFr = tMenu("errors.required");
    if (!altEn.trim()) next.altEn = tMenu("errors.required");
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setMessage({ ok: false, text: tMenu("errors.validation") });
      return;
    }
    const body = new FormData();
    if (file) body.set("file", file);
    body.set("imageAltFr", altFr.trim());
    body.set("imageAltEn", altEn.trim());
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/admin/products/${product.id}/photo`, {
        method: "PUT",
        body,
        timeoutMs: 60_000,
      });
      pick(null);
      setInputKey((k) => k + 1);
      setMessage({ ok: true, text: t("saved") });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: failure(e) });
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/admin/products/${product.id}/photo`, { method: "DELETE" });
      setConfirming(false);
      setAltFr("");
      setAltEn("");
      setMessage({ ok: true, text: t("removed") });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: failure(e) });
    } finally {
      setPending(false);
    }
  };

  const shown = preview ?? product.imageUrl;
  return (
    <Surface className="flex flex-col gap-4">
      <h2 className="font-display text-2xl text-espresso">{t("title")}</h2>
      <p className="text-sm text-espresso-muted">{t("intro")}</p>
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <figure className="flex flex-col gap-1.5">
          {shown ? (
            // A plain <img>: the preview is a local object URL that next/image can't optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shown}
              alt={
                preview
                  ? t("preview")
                  : ((locale === "fr" ? product.imageAltFr : product.imageAltEn) ?? "")
              }
              className="aspect-[4/3] w-full rounded-sm border border-line object-cover"
            />
          ) : (
            <ProductArt
              kind={product.isDrink ? "drink" : "food"}
              caption={tCommon("photoComingSoon")}
              className="rounded-sm"
            />
          )}
          <figcaption className="text-sm text-espresso-muted">
            {preview ? t("preview") : product.imageUrl ? t("current") : t("none")}
          </figcaption>
        </figure>
        <div className="flex flex-col gap-4">
          <TextField
            key={inputKey}
            label={product.imageUrl ? t("replaceFile") : t("file")}
            type="file"
            accept={TYPES.join(",")}
            error={errors.file}
            onChange={(e) => {
              const picked = e.currentTarget.files?.[0] ?? null;
              pick(picked);
              // An empty message clears the field's error.
              setErrors((x) => ({ ...x, file: fileError(picked) ?? "" }));
            }}
          />
          <TextField
            label={t("altFr")}
            hint={t("altHint")}
            lang="fr"
            value={altFr}
            maxLength={200}
            error={errors.altFr}
            onChange={(e) => {
              setAltFr(e.currentTarget.value);
            }}
          />
          <TextField
            label={t("altEn")}
            lang="en"
            value={altEn}
            maxLength={200}
            error={errors.altEn}
            onChange={(e) => {
              setAltEn(e.currentTarget.value);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending} disabled={pending}>
              {t("save")}
            </Button>
            {product.imageUrl && !confirming ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
          {confirming ? (
            <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
              <p className="text-sm text-espresso">{t("removeConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  pending={pending}
                  disabled={pending}
                  onClick={() => void remove()}
                >
                  {tMenu("confirm")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {tMenu("cancel")}
                </Button>
              </div>
            </div>
          ) : null}
          <div aria-live="polite">
            {message ? (
              <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>
            ) : null}
          </div>
        </div>
      </form>
    </Surface>
  );
}
