import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { authorize } from "@/server/authz";
import { AppError } from "@/server/errors";
import { apiRoute } from "@/server/http";
import {
  PHOTO_MAX_BYTES,
  removeProductPhoto,
  setProductPhoto,
} from "@/server/modules/admin/product-photo";
import { getSessionUser } from "@/server/session";
import { fileStorage } from "@/server/storage";

export const dynamic = "force-dynamic";

const tooLarge = () =>
  new AppError("validation_failed", "Invalid photo", [{ path: "file", code: "too_large" }]);

/**
 * PUT /api/v1/admin/products/:id/photo — multipart form: `file` (JPEG, PNG or WebP, optional when
 * only the alt text changes), `imageAltFr`, `imageAltEn`.
 */
export const PUT = apiRoute<{ id: string }>(async (req, { params }) => {
  const user = await getSessionUser();
  authorize(user, "catalog:manage");
  // Refuse oversized bodies before reading them (form fields get 64 KB of headroom).
  if (Number(req.headers.get("content-length") ?? 0) > PHOTO_MAX_BYTES + 65_536) throw tooLarge();
  const form = await req.formData().catch(() => {
    throw new AppError("validation_failed", "Body must be multipart form data");
  });
  const file = form.get("file");
  const result = await setProductPhoto(db(), fileStorage(), user, params.id, {
    file: file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null,
    imageAltFr: form.get("imageAltFr"),
    imageAltEn: form.get("imageAltEn"),
  });
  return NextResponse.json(result);
});

/** DELETE /api/v1/admin/products/:id/photo — the menu shows the illustration again. */
export const DELETE = apiRoute<{ id: string }>(async (_req, { params }) => {
  await removeProductPhoto(db(), fileStorage(), await getSessionUser(), params.id);
  return new NextResponse(null, { status: 204 });
});
