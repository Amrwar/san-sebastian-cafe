import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings: { ALERT_WEBHOOK_URL?: string } = {};
vi.mock("../env", () => ({
  env: () => ({ LOG_LEVEL: "silent", APP_ENV: "staging", ...settings }),
}));
const { formatAlert, reportError, resetReportedErrors, scrub, sendAlert } =
  await import("./alerts");

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  settings.ALERT_WEBHOOK_URL = "https://hooks.example.test/alerts";
  fetchMock.mockReset().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  resetReportedErrors();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const posted = (call = 0) =>
  JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as { text: string; content: string };

describe("scrubbing error texts (alerts never carry personal data or secrets)", () => {
  it("hides emails, phone numbers, ids, keys, bearer tokens and URL credentials", () => {
    const out = scrub(
      "Failed for robin@example.test (514-555-0199) order 0f8c7a52-3b1e-4c1a-9d2e-7a6b5c4d3e2f " +
        "with sk_live_abc123 and Bearer eyJhbGciOi.payload at postgres://app:hunter2@db.host/x",
    );
    expect(out).not.toMatch(/robin|555|0f8c7a52|sk_live|eyJ|hunter2/);
    expect(out).toContain("[email]");
    expect(out).toContain("[number]");
    expect(out).toContain("[id]");
    expect(out).toContain("[key]");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("postgres://[credentials]@db.host/x");
  });

  it("keeps short numbers that carry meaning, and caps the length", () => {
    expect(scrub("applied 10 of 15 migrations")).toBe("applied 10 of 15 migrations");
    expect(scrub("x".repeat(500), 50)).toHaveLength(50);
  });
});

describe("sending alerts", () => {
  it("names the environment and posts both Slack's and Discord's fields", async () => {
    expect(
      formatAlert({ level: "fail", title: "Problem: schema", lines: ["behind"] }, "prod"),
    ).toBe("🔴 [prod] Problem: schema\n• behind");
    expect(await sendAlert({ level: "ok", title: "Recovered: schema" })).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://hooks.example.test/alerts");
    expect(posted()).toEqual({
      text: "🟢 [staging] Recovered: schema",
      content: "🟢 [staging] Recovered: schema",
    });
  });

  it("without a webhook, or when it's down, logs instead and never throws", async () => {
    settings.ALERT_WEBHOOK_URL = undefined;
    expect(await sendAlert({ level: "warn", title: "x" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    settings.ALERT_WEBHOOK_URL = "https://hooks.example.test/alerts";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await sendAlert({ level: "warn", title: "x" })).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect(await sendAlert({ level: "warn", title: "x" })).toBe(false);
  });
});

describe("reporting server errors", () => {
  const ctx = {
    method: "POST",
    path: "/api/v1/orders?ref=abc",
    requestId: "req-12345678",
    source: "api" as const,
  };
  const T0 = 1_800_000_000_000;

  it("sends one scrubbed alert per error and route, then again after the quiet window", async () => {
    const boom = new Error("insert failed for robin@example.test");
    expect(await reportError(boom, ctx, T0)).toBe(true);
    expect(posted().text).toContain("Server error: POST /api/v1/orders");
    expect(posted().text).not.toContain("ref=abc");
    expect(posted().text).not.toContain("robin@");
    expect(posted().text).toContain("request id: req-12345678");

    // The same failure under traffic: no flood.
    expect(
      await reportError(new Error("insert failed for sam@example.test"), ctx, T0 + 1_000),
    ).toBe(false);
    // A different failure, or a different route, is news.
    expect(await reportError(new Error("timeout"), ctx, T0 + 2_000)).toBe(true);
    expect(await reportError(boom, { ...ctx, path: "/api/v1/cart" }, T0 + 3_000)).toBe(true);
    // Ten minutes later the original one alerts again.
    expect(await reportError(boom, ctx, T0 + 10 * 60 * 1000)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
