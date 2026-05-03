import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { passesThreshold, runJudge } from "../src/eval-framework/judge.js";
import type {
  AssertionContext,
  JudgeAssertion,
} from "../src/eval-framework/types.js";

function ctx(): AssertionContext {
  return {
    prompt: "p",
    toolCalls: [],
    finalText: "ans",
    turns: 1,
    stopReason: "end_turn",
    durationMs: 100,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test-model",
  };
}

function fakeAnthropic(textOrError: string | Error): Anthropic {
  const create = async () => {
    if (textOrError instanceof Error) throw textOrError;
    return {
      content: [{ type: "text", text: textOrError }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      stop_reason: "end_turn",
    };
  };
  return { messages: { create } } as unknown as Anthropic;
}

const baseAssertion: JudgeAssertion = {
  kind: "judge",
  name: "j",
  criterion: "answer is correct",
};

describe("passesThreshold", () => {
  it("inclusive on the boundary", () => {
    expect(passesThreshold(0.7, 0.7)).toBe(true);
  });
  it("rejects below threshold", () => {
    expect(passesThreshold(0.69, 0.7)).toBe(false);
  });
  it("rejects non-finite score", () => {
    expect(passesThreshold(Number.NaN, 0.7)).toBe(false);
    expect(passesThreshold(Number.POSITIVE_INFINITY, 0.7)).toBe(false);
  });
  it("rejects non-finite threshold", () => {
    expect(passesThreshold(0.9, Number.NaN)).toBe(false);
  });
});

describe("runJudge — happy path", () => {
  it("passes when score >= threshold", async () => {
    const anthropic = fakeAnthropic('{"score": 0.85, "reasoning": "good"}');
    const result = await runJudge(
      { ...baseAssertion, threshold: 0.7 },
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(true);
    expect(result.outcome.score).toBe(0.85);
    expect(result.outcome.reasoning).toBe("good");
  });

  it("fails when score < threshold (uses default 0.7)", async () => {
    const anthropic = fakeAnthropic('{"score": 0.5, "reasoning": "weak"}');
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0.5);
  });

  it("ignores prose around the JSON object", async () => {
    const anthropic = fakeAnthropic(
      'The judge says: {"score": 0.9, "reasoning": "ok"} (final)',
    );
    const result = await runJudge(
      { ...baseAssertion, threshold: 0.5 },
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(true);
    expect(result.outcome.score).toBe(0.9);
  });

  it("accumulates a non-zero cost", async () => {
    const anthropic = fakeAnthropic('{"score": 0.9, "reasoning": "ok"}');
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    expect(result.cost).toBeGreaterThan(0);
  });
});

describe("runJudge — error paths", () => {
  it("returns failed outcome with error when JSON is malformed", async () => {
    const anthropic = fakeAnthropic("not json");
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toBeDefined();
    expect(result.outcome.error).toContain("Raw:");
  });

  it("returns failed outcome when score is out of [0,1]", async () => {
    const anthropic = fakeAnthropic('{"score": 1.5, "reasoning": "weird"}');
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toBeDefined();
  });

  it("returns failed outcome when reasoning is missing", async () => {
    const anthropic = fakeAnthropic('{"score": 0.9}');
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
  });

  it("returns failed outcome when API throws", async () => {
    const anthropic = fakeAnthropic(new Error("rate limit"));
    const result = await runJudge(
      baseAssertion,
      ctx(),
      anthropic,
      "claude-sonnet-4-6",
      512,
    );
    if (result.outcome.kind !== "judge") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toContain("rate limit");
  });
});
