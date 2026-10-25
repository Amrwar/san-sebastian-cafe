import { env } from "@/server/env";
import { notFound } from "@/server/errors";
import { apiRoute } from "@/server/http";
import { readLocalUpload } from "@/server/storage";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * DEVELOPMENT PHOTO STORAGE — serves files saved by the "local" storage driver. Exists only when
 * STORAGE_DRIVER=local (which environment validation refuses in staging/production).
 */
export const GET = apiRoute<{ key: string[] }>(async (_req, { params }) => {
  if (env().STORAGE_DRIVER !== "local") throw notFound("Route");
  const key = params.key.join("/");
  const type = TYPES[key.split(".").at(-1) ?? ""];
  const bytes = type ? await readLocalUpload(key) : null;
  if (!type || !bytes) throw notFound("File");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": type,
      // Keys are never reused, so a file never changes.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});
