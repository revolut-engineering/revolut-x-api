import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types/**/*.ts"],
      thresholds: {
        statements: 74,
        branches: 62,
        functions: 71,
        lines: 74,
      },
    },
  },
});
