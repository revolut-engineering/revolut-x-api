import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 5_000,
    coverage: {
      provider: "v8",
      include: ["src/eval-framework/**/*.ts"],
      exclude: [
        "src/eval-framework/global-setup.ts",
        "src/eval-framework/index.ts",
        "src/eval-framework/types.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 80,
        branches: 85,
        functions: 85,
        lines: 80,
      },
    },
  },
});
