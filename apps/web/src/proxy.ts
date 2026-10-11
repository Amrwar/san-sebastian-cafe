import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Locale negotiation and prefixing only. Authorization is NOT done here: pages and services
 * check permissions server-side (see src/server/session.ts and src/server/authz.ts).
 */
export default createMiddleware(routing);

export const config = {
  // Everything except API routes, Next internals, generated app icons and files with an extension.
  matcher: ["/((?!api|_next|_vercel|icon|apple-icon|.*\\..*).*)"],
};
