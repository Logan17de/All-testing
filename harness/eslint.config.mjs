import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.ts", "**/*.tsx"];
const webFiles = ["apps/web/**/*.{js,jsx,ts,tsx}"];
const nodeFiles = [
  "scripts/**/*.{js,mjs,cjs}",
  "apps/runtime/**/*.{js,mjs,cjs,ts,tsx}",
  "packages/**/*.{js,mjs,cjs,ts,tsx}",
];

const nextWebConfig = nextVitals.map((config) => ({
  ...config,
  files: webFiles,
}));

const typedConfig = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: typedFiles,
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "coverage/**",
      "apps/web/next-env.d.ts",
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
  ...nextWebConfig,
  ...typedConfig,
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  prettier,
);
