import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      reporter: ["text-summary", "text"],
      // The rules behind every price, tax, tip, stamp and order status (plan Phase 3 exit criteria).
      thresholds: { branches: 95, lines: 95, functions: 95, statements: 95 },
    },
  },
});
