import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "md-text",
      transform(src, id) {
        if (id.endsWith(".md")) {
          return { code: `export default ${JSON.stringify(src)}` };
        }
      },
    },
  ],
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 85,
        branches: 65,
        functions: 87,
        lines: 85,
      },
    },
  },
});
