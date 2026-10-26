import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimits, sql, type Database, type DbHandle } from "@ssc/db";
import { createTestDatabase } from "@ssc/db/testing";
import { AppError } from "./errors";
import { enforceLimit, LIMITS } from "./rate-limit";

let handle: DbHandle;
let db: Database;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await db.execute(sql`truncate table rate_limits`);
});

async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e instanceof AppError ? e.code : "other";
  }
}

describe("request limits", () => {
  const T0 = 1_800_000_000_000;

  it("allows the budget, refuses the next request, and starts over in a new window", async () => {
    const { max, windowSeconds } = LIMITS.placeOrder;
    for (let i = 0; i < max; i++)
      expect(await code(enforceLimit(db, "placeOrder", "user:a", T0 + i))).toBe("ok");
    expect(await code(enforceLimit(db, "placeOrder", "user:a", T0 + max))).toBe("rate_limited");
    // Someone else, or another action, has their own budget.
    expect(await code(enforceLimit(db, "placeOrder", "user:b", T0))).toBe("ok");
    expect(await code(enforceLimit(db, "cartQuote", "user:a", T0))).toBe("ok");
    // After the window: allowed again.
    expect(
      await code(enforceLimit(db, "placeOrder", "user:a", T0 + windowSeconds * 1000 + 1)),
    ).toBe("ok");
  });

  it("counts correctly under simultaneous requests", async () => {
    const { max } = LIMITS.referralCode;
    const results = await Promise.all(
      Array.from({ length: max + 5 }, () => code(enforceLimit(db, "referralCode", "ip:x", T0))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(max);
    const [row] = await db.select().from(rateLimits);
    expect(row!.key).toBe("app:referralCode:ip:x");
  });
});
