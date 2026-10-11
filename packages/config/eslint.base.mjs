// Shared ESLint flat config (TypeScript, type-aware). Apps add framework plugins on top.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": "error",
    },
  },
  // Plain JS config files are not part of any tsconfig project.
  { files: ["**/*.mjs", "**/*.js", "**/*.cjs"], ...tseslint.configs.disableTypeChecked },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.int.test.ts",
      "**/scripts/**",
      "**/*.config.ts",
      "**/seed.ts",
    ],
    rules: { "no-console": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
