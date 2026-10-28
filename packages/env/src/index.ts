import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const APP_ENVS = ["development", "test", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const PLACEHOLDER_SECRET = "replace-me-with-a-random-32-plus-character-secret";

const postgresUrl = z
  .url()
  .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
    message: "must be a postgres:// or postgresql:// URL",
  });

/** An optional setting where an empty value (`KEY=` in .env) means "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: postgresUrl,
    DATABASE_URL_TEST: postgresUrl.optional(),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    /**
     * "console": development only, emails are printed and saved under apps/web/.dev-mail.
     * "smtp": sent through SMTP_URL (Mailpit locally; any provider's SMTP relay when deployed).
     */
    EMAIL_TRANSPORT: z.enum(["console", "smtp"]).default("console"),
    EMAIL_FROM: z.string().min(3),
    /** smtp://user:pass@host:port (or smtps://). Server-only; never logged. */
    SMTP_URL: optional(
      z.url().refine((v) => v.startsWith("smtp://") || v.startsWith("smtps://"), {
        message: "must be an smtp:// or smtps:// URL",
      }),
    ),
    /** Web Push (VAPID) key pair; generate with `npx web-push generate-vapid-keys`. Unset = no push. */
    VAPID_PUBLIC_KEY: optional(
      z.string().regex(/^[A-Za-z0-9_-]{80,100}$/, "must be a VAPID public key"),
    ),
    VAPID_PRIVATE_KEY: optional(
      z.string().regex(/^[A-Za-z0-9_-]{40,50}$/, "must be a VAPID private key"),
    ),
    /** Contact for push services, e.g. mailto:owner@example.com. */
    VAPID_SUBJECT: optional(
      z.string().regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://"),
    ),
    /**
     * Payment boundary. "none": orders can't be placed. "fake": development simulator (no money
     * moves). "stripe": Stripe Checkout — test-mode keys everywhere except production.
     */
    PAYMENT_PROVIDER: z.enum(["none", "fake", "stripe"]).default("none"),
    /** Stripe secret or restricted key (sk_/rk_ + test_/live_). Server-only; never logged. */
    STRIPE_SECRET_KEY: optional(
      z
        .string()
        .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "must be a Stripe secret or restricted key"),
    ),
    /** Signing secret of the Stripe webhook endpoint (or of `stripe listen` locally). */
    STRIPE_WEBHOOK_SECRET: optional(
      z.string().regex(/^whsec_[A-Za-z0-9]+$/, "must be a Stripe webhook signing secret (whsec_…)"),
    ),
    /** Bearer secret for the payment recovery job (/api/cron/payments). Unset = job disabled. */
    CRON_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
    /** Bearer token for /api/health/details (the uptime monitor sends it). Unset = route off. */
    MONITORING_TOKEN: optional(z.string().min(32, "must be at least 32 characters")),
    /**
     * Incoming webhook for alerts (Slack, Discord, Teams, or a monitoring service): server
     * errors and signals turning bad or recovering. Unset = alerts only in the logs.
     */
    ALERT_WEBHOOK_URL: optional(z.url()),
    /**
     * Where product photos live. "local": files under apps/web/.dev-uploads (development only;
     * hosted filesystems are read-only). "vercel-blob": a public Vercel Blob store.
     */
    STORAGE_DRIVER: z.enum(["local", "vercel-blob"]).default("local"),
    /** Set by Vercel when a Blob store is connected (used with the deployment's OIDC token). */
    BLOB_STORE_ID: optional(z.string().min(1)),
    /** Read-write token of a Blob store, for running against the store outside Vercel. */
    BLOB_READ_WRITE_TOKEN: optional(z.string().regex(/^vercel_blob_rw_/, "must be a Blob token")),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === "staging" || env.APP_ENV === "production";
    if (deployed && env.BETTER_AUTH_SECRET === PLACEHOLDER_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message: "placeholder secret is not allowed outside development",
      });
    }
    if (deployed && env.EMAIL_TRANSPORT === "console") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: "console email transport is development-only; configure a real provider",
      });
    }
    if (env.EMAIL_TRANSPORT === "smtp" && !env.SMTP_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_URL"],
        message: "required when EMAIL_TRANSPORT=smtp",
      });
    }
    if (
      deployed &&
      env.SMTP_URL?.startsWith("smtp://") &&
      !/:(587|2525)(\/|$)/.test(env.SMTP_URL)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_URL"],
        message: "use smtps:// (or STARTTLS on port 587) outside development",
      });
    }
    const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT];
    if (vapid.some(Boolean) && !vapid.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["VAPID_PUBLIC_KEY"],
        message: "set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together",
      });
    }
    if (deployed && env.ALERT_WEBHOOK_URL && !env.ALERT_WEBHOOK_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["ALERT_WEBHOOK_URL"],
        message: "must be an https:// URL outside development",
      });
    }
    if (deployed && env.PAYMENT_PROVIDER === "fake") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_PROVIDER"],
        message: "the fake payment simulator is development-only",
      });
    }
    if (env.PAYMENT_PROVIDER === "stripe") {
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when PAYMENT_PROVIDER=stripe",
          });
      }
      const live = env.STRIPE_SECRET_KEY?.includes("_live_") ?? false;
      // Real money only in production; production never runs on test keys.
      if (live && env.APP_ENV !== "production")
        ctx.addIssue({
          code: "custom",
          path: ["STRIPE_SECRET_KEY"],
          message: "live keys are only allowed when APP_ENV=production; use test-mode keys",
        });
      if (!live && env.STRIPE_SECRET_KEY && env.APP_ENV === "production")
        ctx.addIssue({
          code: "custom",
          path: ["STRIPE_SECRET_KEY"],
          message: "production requires a live-mode key",
        });
    }
    if (deployed && env.STORAGE_DRIVER === "local") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_DRIVER"],
        message: "local file storage is development-only; use vercel-blob",
      });
    }
    if (env.STORAGE_DRIVER === "vercel-blob" && !env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["BLOB_STORE_ID"],
        message: "required (or BLOB_READ_WRITE_TOKEN) when STORAGE_DRIVER=vercel-blob",
      });
    }
    if (deployed && !env.BETTER_AUTH_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must use https outside development",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/** Pure parser — never logs secret values, only variable names and messages. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  // Vercel preview deployments each get their own URL; use it when no explicit URL is set.
  const effective =
    !source.BETTER_AUTH_URL && source.VERCEL_URL
      ? { ...source, BETTER_AUTH_URL: `https://${source.VERCEL_URL}` }
      : source;
  const result = serverEnvSchema.safeParse(effective);
  const issues = result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  // On a hosting platform, never fall back to the permissive "development" default silently.
  if (source.VERCEL && !source.APP_ENV) {
    issues.unshift(
      "APP_ENV: must be set explicitly on Vercel (development, staging or production)",
    );
  }
  if (!result.success || issues.length > 0) throw new EnvValidationError(issues);
  return result.data;
}

/**
 * Loads the monorepo-root `.env` (if present) without overriding variables already set
 * by the shell/CI/hosting platform.
 */
export function loadRootEnv(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(join(dir, "turbo.json")) && existsSync(candidate)) {
      loadDotenv({ path: candidate, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

let cached: ServerEnv | undefined;

/** Validated server environment (memoized). Throws EnvValidationError on invalid config. */
export function getServerEnv(): ServerEnv {
  if (!cached) {
    loadRootEnv();
    cached = parseServerEnv(process.env);
  }
  return cached;
}
