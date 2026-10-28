import "server-only";
import { randomUUID } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, fromZodError, toProblem } from "./errors";
import { env } from "./env";
import { logger } from "./logger";
import { reportError } from "./monitoring/alerts";
import { drainOutbox } from "./notifications/deliver";

export const REQUEST_ID_HEADER = "x-request-id";

export interface RequestContext {
  requestId: string;
  log: ReturnType<typeof logger>;
}

type Handler<P> = (req: NextRequest, ctx: RequestContext & { params: P }) => Promise<Response>;

/**
 * Wraps a route handler with a request id, structured access/error logging and RFC 9457
 * problem responses. Every API route goes through this wrapper.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (on top of SameSite=Lax cookies): browsers send `Origin` on cross-site
 * requests, so a state-changing request whose Origin isn't this app is refused. Requests without
 * an Origin header (server-to-server, native apps) are allowed and rely on their own credentials.
 */
function assertSameOrigin(req: NextRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const allowed = new Set([new URL(env().BETTER_AUTH_URL).origin, req.nextUrl.origin]);
  if (!allowed.has(origin))
    throw new AppError("forbidden", "Cross-site request refused", [], "cross_origin");
}

export function apiRoute<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const incoming = req.headers.get(REQUEST_ID_HEADER);
    const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    const log = logger().child({ requestId, method: req.method, path: req.nextUrl.pathname });
    const started = performance.now();
    let response: Response;
    try {
      assertSameOrigin(req);
      response = await handler(req, { requestId, log, params: await segment.params });
    } catch (error) {
      const problem = toProblem(error, requestId);
      if (problem.status >= 500) {
        log.error({ err: error }, "request failed");
        const ctx = {
          method: req.method,
          path: req.nextUrl.pathname,
          requestId,
          source: "api" as const,
        };
        afterResponse(() => reportError(error, ctx));
      } else log.info({ code: problem.code }, "request rejected");
      response = NextResponse.json(problem, {
        status: problem.status,
        headers: { "content-type": "application/problem+json" },
      });
    }
    // A change may have queued customer notifications: send them once the response is out.
    if (!SAFE_METHODS.has(req.method) && response.status < 400) afterResponse(() => drainOutbox());
    response.headers.set(REQUEST_ID_HEADER, requestId);
    log.debug(
      { status: response.status, ms: Math.round(performance.now() - started) },
      "request completed",
    );
    return response;
  };
}

/** Runs work once the response is sent; outside a request (tests, scripts) it just starts it. */
function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** Parses and validates a JSON body. Malformed JSON and schema violations become 400 problems. */
export async function parseJson<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("validation_failed", "Body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
