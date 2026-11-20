import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  js.configs.recommended,
  {
    files: ["frontend/**/*.ts", "vitest.config.ts"],
    extends: [...ts.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
      },
    },
  },
  {
    // Playwright evaluates these callbacks inside the browser page.
    files: ["scripts/integration.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        DOMException: "readonly",
      },
    },
  },
);
