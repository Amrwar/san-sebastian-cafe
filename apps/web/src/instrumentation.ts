import type { Instrumentation } from "next";

/** Runs once when a server instance starts: fail fast on invalid configuration. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@ssc/env");
    getServerEnv();
  }
}

/**
 * Server errors Next.js caught outside our API wrapper (pages, server actions): alert, deduped.
 * API routes report their own 5xx responses, so route errors aren't reported twice.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || context.routeType === "route") return;
  const { reportError } = await import("./server/monitoring/alerts");
  const digest =
    typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined;
  await reportError(err, {
    method: request.method,
    path: request.path,
    digest,
    source:
      context.routeType === "action"
        ? "action"
        : context.routeType === "proxy"
          ? "proxy"
          : "render",
  });
};
