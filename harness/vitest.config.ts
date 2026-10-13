import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next preserves JSX; tests compile real components with React's automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-*/**",
      "**/*review-dist/**",
    ],
    clearMocks: true,
    restoreMocks: true,
    // Windows cold PowerShell/C# startup competes with process-heavy HTTP fixtures.
    // Serialize cold native bridge compilation rather than weakening operation deadlines.
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
