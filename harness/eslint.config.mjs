import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.ts", "**/*.tsx"];
const nodeFiles = [
  "scripts/**/*.{js,mjs,cjs}",
  "apps/runtime/**/*.{js,mjs,cjs,ts,tsx}",
  "packages/**/*.{js,mjs,cjs,ts,tsx}",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "coverage/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
  },
  {
    files: nodeFiles,
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: typedFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
);
