import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // HSTS only matters over HTTPS; browsers ignore it on http://localhost.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // A nonce-based Content-Security-Policy is added in Phase 15 (hardening), once third-party
  // payment scripts are known.
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@ssc/ui", "@ssc/domain", "@ssc/db", "@ssc/env"],
  serverExternalPackages: ["pino"],
  images: {
    // Product photos: the Vercel Blob store, or the development storage route.
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }],
    localPatterns: [{ pathname: "/api/dev/uploads/**", search: "" }],
  },
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
};

export default withNextIntl(config);
