import { toNextJsHandler } from "better-auth/next-js";
import type { NextRequest } from "next/server";
import { auth } from "@/server/auth";

// Better Auth endpoints (sign-in codes, session, sign-out). Rate-limited by Better Auth.
export function GET(req: NextRequest) {
  return toNextJsHandler(auth()).GET(req);
}

export function POST(req: NextRequest) {
  return toNextJsHandler(auth()).POST(req);
}
