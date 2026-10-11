import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it.each([
    ["/fr/account", "/fr/account"],
    ["/en/staff?tab=1", "/en/staff?tab=1"],
  ])("keeps relative path %s", (input, expected) => {
    expect(safeRedirectPath(input, "/fallback")).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/fr\n/x",
  ])("rejects %s", (input) => {
    expect(safeRedirectPath(input, "/fallback")).toBe("/fallback");
  });
});
