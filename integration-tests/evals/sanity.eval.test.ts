import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval } = await import("../src/eval-framework/index.js");

describe("sanity", () => {
  defineEval({
    name: "no-tool-call-question",
    description: "Pure-text question requires no MCP tool",
    prompt: "What is 2 + 2? Answer with just the number, no tool calls needed.",
    trials: 1,
    passThreshold: 1,
    assertions: [
      {
        name: "invokes zero tools",
        check: ({ toolCalls }) => toolCalls.length === 0,
      },
      {
        name: "answer mentions 4",
        check: ({ finalText }) => /\b4\b/.test(finalText),
      },
    ],
  });
});
