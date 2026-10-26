import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

/*
 * Locale negotiation and prefixing, plus the Content Security Policy. Authorization is NOT done
 * here: pages and services check permissions server-side (see src/server/session.ts and
 * src/server/authz.ts).
 */

const handleI18nRouting = createMiddleware(routing);

/**
 * The policy for one page view. Scripts run only from this site and with this request's nonce
 * (Next.js adds it to its own scripts); nothing can frame the site or post forms elsewhere.
 * Payment happens on Stripe's own page (a redirect), so no Stripe origin is needed here.
 */
export function contentSecurityPolicy(
  nonce: string,
  { dev, https }: { dev: boolean; https: boolean },
) {
  return [
    "default-src 'self'",
    // Development: React's error overlay needs eval, and hot reload injects styles.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // Style attributes (image sizing, chart bars) can't carry a nonce; they can't run code.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export default function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  const response = handleI18nRouting(request);
  response.headers.set("Content-Security-Policy", csp);

  // Hand the policy (and so the nonce) to rendering, the way NextResponse.next({ request })
  // does, while keeping next-intl's redirect or rewrite.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);
  const forward = NextResponse.next({ request: { headers: requestHeaders } });
  forward.headers.forEach((value, key) => {
    if (key.startsWith("x-middleware-request-") || key === "x-middleware-override-headers")
      response.headers.set(key, value);
  });
  return response;
}

export const config = {
  // Everything except API routes, Next internals, generated app icons and files with an extension.
  matcher: ["/((?!api|_next|_vercel|icon|apple-icon|.*\\..*).*)"],
};
