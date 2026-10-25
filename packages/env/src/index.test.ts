import { describe, expect, it } from "vitest";
import { EnvValidationError, parseServerEnv } from "./index";

const valid = {
  APP_ENV: "development",
  DATABASE_URL: "postgres://u:p@localhost:5442/db",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  EMAIL_FROM: "Cafe <a@b.invalid>",
};

describe("parseServerEnv", () => {
  it("accepts a valid development config and applies defaults", () => {
    const env = parseServerEnv(valid);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.EMAIL_TRANSPORT).toBe("console");
  });

  it("rejects missing and malformed values, naming the variable but not the value", () => {
    try {
      parseServerEnv({ ...valid, DATABASE_URL: "mysql://nope", BETTER_AUTH_SECRET: "short" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("BETTER_AUTH_SECRET");
      expect(msg).not.toContain("short");
    }
  });

  it("requires an explicit APP_ENV on Vercel", () => {
    expect(() => parseServerEnv({ ...valid, APP_ENV: undefined, VERCEL: "1" })).toThrow(/APP_ENV/);
    expect(parseServerEnv({ ...valid, VERCEL: "1" }).APP_ENV).toBe("development");
  });

  it("derives the auth URL from the Vercel deployment URL when not set", () => {
    const env = parseServerEnv({
      ...valid,
      BETTER_AUTH_URL: undefined,
      VERCEL_URL: "ssc-abc.vercel.app",
    });
    expect(env.BETTER_AUTH_URL).toBe("https://ssc-abc.vercel.app");
  });

  it("defaults to no payment provider and forbids the simulator outside development", () => {
    expect(parseServerEnv(valid).PAYMENT_PROVIDER).toBe("none");
    expect(parseServerEnv({ ...valid, PAYMENT_PROVIDER: "fake" }).PAYMENT_PROVIDER).toBe("fake");
    expect(() =>
      parseServerEnv({ ...valid, APP_ENV: "staging", PAYMENT_PROVIDER: "fake" }),
    ).toThrow(/PAYMENT_PROVIDER/);
  });

  it("requires Stripe keys for the Stripe provider, and test-mode keys outside production", () => {
    const stripe = {
      ...valid,
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_abc123",
      STRIPE_WEBHOOK_SECRET: "whsec_abc123",
    };
    expect(parseServerEnv(stripe).PAYMENT_PROVIDER).toBe("stripe");
    expect(() => parseServerEnv({ ...stripe, STRIPE_WEBHOOK_SECRET: undefined })).toThrow(
      /STRIPE_WEBHOOK_SECRET: required/,
    );
    expect(() => parseServerEnv({ ...stripe, STRIPE_SECRET_KEY: "pk_test_abc" })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    // An empty "KEY=" line counts as not set.
    expect(() => parseServerEnv({ ...stripe, STRIPE_SECRET_KEY: "" })).toThrow(
      /STRIPE_SECRET_KEY: required/,
    );
    expect(parseServerEnv({ ...valid, STRIPE_SECRET_KEY: "", CRON_SECRET: "" }).CRON_SECRET).toBe(
      undefined,
    );
    expect(() => parseServerEnv({ ...stripe, STRIPE_SECRET_KEY: "sk_live_abc123" })).toThrow(
      /live keys are only allowed when APP_ENV=production/,
    );
  });

  it("stores photos locally in development and needs Blob credentials for Vercel Blob", () => {
    expect(parseServerEnv(valid).STORAGE_DRIVER).toBe("local");
    expect(() => parseServerEnv({ ...valid, APP_ENV: "staging" })).toThrow(/STORAGE_DRIVER/);
    const blob = { ...valid, STORAGE_DRIVER: "vercel-blob" };
    expect(() => parseServerEnv(blob)).toThrow(/BLOB_STORE_ID/);
    expect(parseServerEnv({ ...blob, BLOB_STORE_ID: "store_abc" }).STORAGE_DRIVER).toBe(
      "vercel-blob",
    );
    expect(() => parseServerEnv({ ...blob, BLOB_READ_WRITE_TOKEN: "nope" })).toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    );
    expect(() =>
      parseServerEnv({ ...blob, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc_123" }),
    ).not.toThrow();
  });

  it("sends email through SMTP when configured, and takes VAPID keys as a set", () => {
    const smtp = { ...valid, EMAIL_TRANSPORT: "smtp" };
    expect(() => parseServerEnv(smtp)).toThrow(/SMTP_URL/);
    expect(parseServerEnv({ ...smtp, SMTP_URL: "smtp://localhost:1025" }).EMAIL_TRANSPORT).toBe(
      "smtp",
    );
    const deployed = {
      ...smtp,
      APP_ENV: "staging",
      BETTER_AUTH_URL: "https://cafe.example",
      STORAGE_DRIVER: "vercel-blob",
      BLOB_STORE_ID: "store_abc",
    };
    expect(() => parseServerEnv({ ...deployed, SMTP_URL: "smtp://relay.example:25" })).toThrow(
      /SMTP_URL/,
    );
    expect(() =>
      parseServerEnv({ ...deployed, SMTP_URL: "smtps://u:p@relay.example:465" }),
    ).not.toThrow();
    expect(() => parseServerEnv({ ...valid, VAPID_SUBJECT: "mailto:a@b.c" })).toThrow(
      /VAPID_PUBLIC_KEY/,
    );
  });

  it("forbids development-only settings in production", () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        APP_ENV: "production",
        BETTER_AUTH_SECRET: "replace-me-with-a-random-32-plus-character-secret",
      }),
    ).toThrow(/BETTER_AUTH_SECRET[\s\S]*EMAIL_TRANSPORT[\s\S]*BETTER_AUTH_URL/);
  });
});
