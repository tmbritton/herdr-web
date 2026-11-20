import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(js.configs.recommended, ...ts.configs.recommended, {
  files: ["frontend/**/*.ts", "scripts/*.mjs"],
  languageOptions: {
    globals: {
      console: "readonly",
      process: "readonly",
      URL: "readonly",
      fetch: "readonly",
    },
  },
});
