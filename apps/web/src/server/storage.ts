import "server-only";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { del, put } from "@vercel/blob";
import { AppError } from "./errors";
import { env } from "./env";

/**
 * File storage boundary (product photos). Files are public and never overwritten: each upload gets
 * a fresh key, so a new photo has a new URL and no cache ever serves the old one.
 */
export interface FileStorage {
  /** Stores a file and returns its public URL. `key` is a path such as `products/<id>/latte.jpg`. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
  /** Deletes a file this storage holds. */
  remove(url: string): Promise<void>;
  /** Whether `url` points into this storage (other URLs are never deleted). */
  owns(url: string): boolean;
}

/** Safe key segments only: no traversal, no hidden files. */
const KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.[a-z0-9]+$/;

export const LOCAL_UPLOAD_PREFIX = "/api/dev/uploads/";
const localRoot = () => join(process.cwd(), ".dev-uploads");

/**
 * Development storage: files under `apps/web/.dev-uploads`, served by /api/dev/uploads. Hosted
 * filesystems are read-only, so on Vercel an upload is refused with a clear reason instead.
 */
export const localFileStorage: FileStorage = {
  async put(key, bytes) {
    if (process.env.VERCEL)
      throw new AppError(
        "unprocessable",
        "Photo storage not configured",
        [],
        "storage_unavailable",
      );
    if (!KEY.test(key)) throw new Error(`invalid storage key ${key}`);
    const file = join(localRoot(), key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { url: `${LOCAL_UPLOAD_PREFIX}${key}` };
  },
  async remove(url) {
    const key = url.slice(LOCAL_UPLOAD_PREFIX.length);
    if (!this.owns(url) || !KEY.test(key)) return;
    await unlink(join(localRoot(), key)).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    });
  },
  owns: (url) => url.startsWith(LOCAL_UPLOAD_PREFIX),
};

/** Reads a locally stored file, or null when the key is invalid or missing. */
export async function readLocalUpload(key: string): Promise<Uint8Array | null> {
  if (!KEY.test(key)) return null;
  return readFile(join(localRoot(), key)).catch(() => null);
}

/**
 * Vercel Blob (public store). Credentials come from the environment: BLOB_STORE_ID with the
 * deployment's OIDC token on Vercel, or BLOB_READ_WRITE_TOKEN elsewhere.
 */
export const vercelBlobStorage: FileStorage = {
  async put(key, bytes, contentType) {
    const blob = await put(key, Buffer.from(bytes), {
      access: "public",
      contentType,
      addRandomSuffix: true,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return { url: blob.url };
  },
  async remove(url) {
    if (this.owns(url)) await del(url);
  },
  owns(url) {
    try {
      return new URL(url).hostname.endsWith(".public.blob.vercel-storage.com");
    } catch {
      return false;
    }
  },
};

/** The configured storage. */
export function fileStorage(): FileStorage {
  return env().STORAGE_DRIVER === "vercel-blob" ? vercelBlobStorage : localFileStorage;
}
