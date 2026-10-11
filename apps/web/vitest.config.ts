import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.int.test.ts"] },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
