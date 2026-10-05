import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    clearMocks: true,
    restoreMocks: true,
    // Windows cold PowerShell/C# startup competes with process-heavy HTTP fixtures.
    // Bound test concurrency rather than weakening operation or assertion deadlines.
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
  },
});
