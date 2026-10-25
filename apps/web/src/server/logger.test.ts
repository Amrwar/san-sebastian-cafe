import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ env: () => ({ LOG_LEVEL: "info", APP_ENV: "test" }) }));
const { createLogger } = await import("./logger");

/** Logs one entry and returns what would have been written. */
function written(entry: Record<string, unknown>): string {
  let out = "";
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out += chunk.toString();
      done();
    },
  });
  createLogger({ destination }).info(entry, "test entry");
  return out;
}

describe("log redaction (personal data never reaches the logs)", () => {
  it("hides contact details, codes and secrets, at any of the first three levels", () => {
    const out = written({
      email: "robin@example.test",
      order: {
        guestEmail: "guest@example.test",
        guestName: "Robin Tremblay",
        guestPhone: "514-555-0199",
        deliveryAddress: { street: "1 rue Sainte-Catherine" },
      },
      request: { headers: { authorization: "Bearer abc", cookie: "session=xyz" } },
      session: { token: "tok_123", ipAddress: "203.0.113.7", userAgent: "Firefox" },
      signIn: { code: "123456", otp: "654321" },
      privacy: { contact: "514-555-0100", confirmEmail: "robin@example.test" },
      orderId: "8f1c-ok",
    });
    for (const secret of [
      "robin@example.test",
      "guest@example.test",
      "Robin Tremblay",
      "514-555-0199",
      "Sainte-Catherine",
      "Bearer abc",
      "session=xyz",
      "tok_123",
      "203.0.113.7",
      "Firefox",
      "123456",
      "654321",
      "514-555-0100",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    // Identifiers stay, so logs remain useful.
    expect(out).toContain("8f1c-ok");
  });
});
