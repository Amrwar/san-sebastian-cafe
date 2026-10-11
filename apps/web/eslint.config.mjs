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
    // Module boundaries: browser code must never import server-only modules or the database.
    files: ["src/components/**", "src/lib/**", "src/app/**/*.tsx"],
    ignores: [
      "src/app/**/page.tsx",
      "src/app/**/layout.tsx",
      "src/app/**/not-found.tsx",
      "src/components/SiteHeader.tsx",
      "src/components/SiteFooter.tsx",
      "src/components/Forbidden.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "@ssc/db", "@ssc/db/*", "@ssc/env"],
              message: "Client components must not import server modules.",
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
