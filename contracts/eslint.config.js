import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // The contract is declarations only — flag anything that would emit
      // runtime code and silently make this package a real dependency.
      "@typescript-eslint/consistent-type-exports": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Program > :matches(FunctionDeclaration, ClassDeclaration, VariableDeclaration, ExpressionStatement)",
          message:
            "@argus/contracts is types-only: declare interfaces and type aliases, never runtime code.",
        },
      ],
    },
  },
]);
