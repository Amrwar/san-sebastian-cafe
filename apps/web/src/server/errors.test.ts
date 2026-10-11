import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, forbidden, toProblem } from "./errors";

describe("toProblem", () => {
  it("maps application errors to their HTTP status and code", () => {
    const problem = toProblem(forbidden("admin_console:access"), "req-1");
    expect(problem).toMatchObject({ status: 403, code: "forbidden", requestId: "req-1" });
  });

  it("maps zod errors to 400 with field paths but no input values", () => {
    const result = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    expect(result.success).toBe(false);
    const problem = toProblem(result.error, "req-2");
    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([{ path: "name", code: "too_small" }]);
  });

  it("hides details of unexpected errors", () => {
    const problem = toProblem(new Error("password=hunter2 leaked"), "req-3");
    expect(problem).toMatchObject({
      status: 500,
      code: "internal",
      title: "Internal server error",
    });
    expect(JSON.stringify(problem)).not.toContain("hunter2");
  });

  it("keeps conflict semantics", () => {
    expect(toProblem(new AppError("conflict", "Order changed"), "r").status).toBe(409);
  });
});
