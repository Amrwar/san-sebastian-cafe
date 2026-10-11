import type { NextRequest } from "next/server";

/** Guests prove access to their order with a token: header (API clients) or `?token=` (links). */
export function orderTokenFrom(req: NextRequest): string | null {
  return req.headers.get("x-order-token") ?? req.nextUrl.searchParams.get("token");
}
