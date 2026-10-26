import { expect, test, type Page } from "@playwright/test";

/*
 * Performance budgets on the production build. JavaScript is counted as compressed bytes over the
 * wire on a cold load; LCP and CLS come from the browser's own performance entries. LCP here has
 * no network or CPU throttling, so its budget catches regressions, not real-phone speed.
 */

interface Measured {
  /** Compressed JavaScript bytes transferred on a cold load. */
  jsKb: number;
  /** Largest Contentful Paint (ms). */
  lcp: number;
  /** Cumulative Layout Shift. */
  cls: number;
}

/** LCP and CLS budgets are Google's "good" thresholds. */
const LCP_MS = 2500;
const CLS = 0.1;

async function measure(page: Page, path: string): Promise<Measured> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  return page.evaluate(async () => {
    const observed = (type: string) =>
      new Promise<PerformanceEntry[]>((resolve) => {
        new PerformanceObserver((list) => {
          resolve(list.getEntries());
        }).observe({ type, buffered: true });
        // Types with no entries never call back.
        setTimeout(() => {
          resolve([]);
        }, 500);
      });
    const js = performance
      .getEntriesByType("resource")
      .filter((e) => (e as PerformanceResourceTiming).initiatorType === "script")
      .reduce((sum, e) => sum + (e as PerformanceResourceTiming).transferSize, 0);
    const lcp = (await observed("largest-contentful-paint")).at(-1)?.startTime ?? 0;
    const cls = (await observed("layout-shift"))
      .map((e) => e as PerformanceEntry & { value: number; hadRecentInput: boolean })
      .filter((e) => !e.hadRecentInput)
      .reduce((sum, e) => sum + e.value, 0);
    return { jsKb: Math.round(js / 1024), lcp: Math.round(lcp), cls: Number(cls.toFixed(3)) };
  });
}

async function expectWithin(page: Page, path: string, jsKbBudget: number) {
  const m = await measure(page, path);
  console.log(`${path}: ${m.jsKb} KB JS (≤${jsKbBudget}), LCP ${m.lcp} ms, CLS ${m.cls}`);
  expect.soft(m.jsKb, `${path} JavaScript (KB, compressed)`).toBeLessThanOrEqual(jsKbBudget);
  expect.soft(m.lcp, `${path} LCP (ms)`).toBeLessThanOrEqual(LCP_MS);
  expect.soft(m.cls, `${path} CLS`).toBeLessThanOrEqual(CLS);
}

// One test per page: each gets a fresh browser context, so every load is cold (nothing cached).
// JS budgets: ~20 % over the 2026-10-26 build (160–171 KB); raise them only on purpose.
const CUSTOMER_PAGES: Array<[path: string, jsKb: number]> = [
  ["/fr", 195],
  ["/fr/menu", 195],
  ["/fr/menu/demo-latte", 200],
  ["/fr/cart", 195],
  ["/fr/sign-in", 205],
];

test.describe("performance budgets", () => {
  for (const [path, jsKb] of CUSTOMER_PAGES) {
    test(`${path} stays light and stable`, async ({ page }) => {
      await expectWithin(page, path, jsKb);
    });
  }

  test.describe("staff", () => {
    test.use({ storageState: "e2e/.auth/staff.json" });

    test("the live queue stays light on a counter tablet", async ({ page }) => {
      await expectWithin(page, "/fr/staff", 195);
    });
  });
});
