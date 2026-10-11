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
