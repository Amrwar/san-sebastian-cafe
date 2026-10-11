import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import base from "@ssc/config/eslint";

export default [
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      ".dev-mail/**",
      "public/sw.js",
    ],
  },
  ...base,
  {
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.strict.rules,
    },
  },
  {
    // Module boundary. Convention: browser code lives in `*.client.tsx` files and `src/lib/**`.
    // It may import server TYPES (erased at build time) but never server values or the database.
    files: ["src/lib/**", "**/*.client.tsx", "src/app/**/error.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "@ssc/db", "@ssc/db/*", "@ssc/env"],
              message:
                "Client code must not import server modules (type-only imports are allowed).",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["e2e/**"],
    rules: { "no-console": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
];
