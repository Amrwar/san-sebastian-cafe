import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";

/*
 * Every private API route (admin, staff, the customer's own data) refuses a caller with no session,
 * found by reading the route files, so a new route can't be forgotten. And no state-changing request
 * from another site is accepted (CSRF defence in depth).
 */

const API = join(process.cwd(), "src", "app", "api", "v1");
const PRIVATE = ["admin", "staff", "me"];

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? routeFiles(join(dir, e.name))
        : Promise.resolve(e.name === "route.ts" ? [join(dir, e.name)] : []),
    ),
  );
  return files.flat();
}

/** The URL of a route file, with dynamic segments filled with harmless values. */
function urlOf(file: string): string {
  const path = relative(API, file)
    .replace(/\\/g, "/")
    .replace(/\/route\.ts$/, "");
  const filled = path
    .replace(/\[date\]/g, "2030-01-01")
    .replace(/\[\.\.\.\w+\]/g, "x")
    .replace(/\[\w+\]/g, "00000000-0000-4000-8000-000000000000");
  return `/api/v1/${filled}`;
}

test("every private API route refuses an anonymous caller", async ({ request }) => {
  const checked: string[] = [];
  for (const area of PRIVATE) {
    for (const file of await routeFiles(join(API, area))) {
      const source = await readFile(file, "utf8");
      const methods = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map(
        (m) => m[1]!,
      );
      for (const method of methods) {
        const url = urlOf(file);
        const response = await request.fetch(url, {
          method,
          data: method === "GET" ? undefined : {},
        });
        checked.push(`${method} ${url} → ${response.status()}`);
      }
    }
  }
  // Every route answers 401 (listed all together, so one run shows every gap).
  expect(checked.filter((line) => !line.endsWith("→ 401"))).toEqual([]);
  // The sweep found the routes (a broken glob would pass vacuously).
  expect(checked.length).toBeGreaterThan(40);
});

test("state-changing requests from another site are refused", async ({ request }) => {
  const response = await request.post("/api/v1/cart/quote", {
    headers: { origin: "https://evil.example" },
    data: { lines: [] },
  });
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { reason?: string }).reason).toBe("cross_origin");
});
