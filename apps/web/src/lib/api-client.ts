"use client";

/** Errors the UI distinguishes so it can show the right message and recovery action. */
export type ApiFailure =
  | { kind: "offline" }
  | { kind: "timeout" }
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "validation"; fields: string[] }
  | { kind: "forbidden" }
  | { kind: "conflict"; reason: string | null }
  | { kind: "unprocessable"; reason: string | null }
  | { kind: "rate_limited" }
  | { kind: "server"; requestId: string | null };

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.kind);
    this.name = "ApiError";
  }
}

/**
 * JSON fetch against our own API with a timeout, an abort signal and typed failures.
 * Responses follow RFC 9457 on error (see src/server/errors.ts).
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  if (typeof navigator !== "undefined" && !navigator.onLine)
    throw new ApiError({ kind: "offline" });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, init.timeoutMs ?? 10_000);
  init.signal?.addEventListener("abort", () => {
    controller.abort();
  });

  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(controller.signal.aborted ? { kind: "timeout" } : { kind: "offline" });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  const problem = (await response.json().catch(() => ({}))) as {
    errors?: Array<{ path: string }>;
    requestId?: string;
    reason?: string;
  };
  if (response.status === 401) throw new ApiError({ kind: "unauthenticated" });
  if (response.status === 403) throw new ApiError({ kind: "forbidden" });
  if (response.status === 404) throw new ApiError({ kind: "not_found" });
  if (response.status === 409)
    throw new ApiError({ kind: "conflict", reason: problem.reason ?? null });
  if (response.status === 422)
    throw new ApiError({ kind: "unprocessable", reason: problem.reason ?? null });
  if (response.status === 429) throw new ApiError({ kind: "rate_limited" });
  if (response.status === 400) {
    throw new ApiError({ kind: "validation", fields: problem.errors?.map((e) => e.path) ?? [] });
  }
  throw new ApiError({
    kind: "server",
    requestId: problem.requestId ?? response.headers.get("x-request-id"),
  });
}
