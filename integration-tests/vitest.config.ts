import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

loadDotenv({
  path: fileURLToPath(new URL("./.env", import.meta.url)),
  override: false,
});

const apiSrc = fileURLToPath(new URL("../api/src/index.ts", import.meta.url));
const globalSetup = fileURLToPath(
  new URL("./src/eval-framework/global-setup.ts", import.meta.url),
);

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
    include: ["evals/**/*.eval.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globalSetup: [globalSetup],
  },
  resolve: {
    alias: {
      "@revolut/revolut-x-api": apiSrc,
    },
  },
});
