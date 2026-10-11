import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, fromZodError, toProblem } from "./errors";
import { logger } from "./logger";

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
export function apiRoute<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const incoming = req.headers.get(REQUEST_ID_HEADER);
    const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    const log = logger().child({ requestId, method: req.method, path: req.nextUrl.pathname });
    const started = performance.now();
    let response: Response;
    try {
      response = await handler(req, { requestId, log, params: await segment.params });
    } catch (error) {
      const problem = toProblem(error, requestId);
      if (problem.status >= 500) log.error({ err: error }, "request failed");
      else log.info({ code: problem.code }, "request rejected");
      response = NextResponse.json(problem, {
        status: problem.status,
        headers: { "content-type": "application/problem+json" },
      });
    }
    response.headers.set(REQUEST_ID_HEADER, requestId);
    log.debug(
      { status: response.status, ms: Math.round(performance.now() - started) },
      "request completed",
    );
    return response;
  };
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
