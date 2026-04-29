import { describe, it, expect } from "vitest";
import { runSemantic } from "../src/eval-framework/semantic.js";
import type { Embedder } from "../src/eval-framework/index.js";
import type {
  AssertionContext,
  SemanticAssertion,
} from "../src/eval-framework/types.js";

function ctx(finalText: string): AssertionContext {
  return {
    prompt: "p",
    toolCalls: [],
    finalText,
    turns: 0,
    stopReason: "end_turn",
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test-model",
  };
}

function stubEmbedder(vectors: number[][]): Embedder {
  return {
    provider: "local",
    model: "stub",
    async embed(texts: string[]) {
      if (vectors.length !== texts.length) {
        throw new Error(
          `stub mismatch: ${texts.length} inputs, ${vectors.length} canned vectors`,
        );
      }
      return { vectors, tokens: texts.reduce((s, t) => s + t.length, 0) };
    },
  };
}

describe("runSemantic — mode any", () => {
  it("passes when at least one reference exceeds threshold", async () => {
    const embedder = stubEmbedder([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "matches-any",
      references: ["matching", "different"],
      threshold: 0.6,
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx("hello"), embedder);
    expect(result.outcome.kind).toBe("semantic");
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.passed).toBe(true);
    expect(result.outcome.score).toBeCloseTo(1, 5);
  });

  it("fails when no reference exceeds threshold", async () => {
    const embedder = stubEmbedder([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "matches-any",
      reference: "different",
      threshold: 0.5,
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx("hello"), embedder);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBeCloseTo(0, 5);
  });
});

describe("runSemantic — mode avg", () => {
  it("averages similarities across references", async () => {
    const embedder = stubEmbedder([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "matches-avg",
      references: ["a", "b"],
      threshold: 0.4,
      mode: "avg",
    };
    const result = await runSemantic(assertion, ctx("hello"), embedder);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.score).toBeCloseTo(0.5, 5);
    expect(result.outcome.passed).toBe(true);
  });
});

describe("runSemantic — error paths", () => {
  it("returns score 0 + error when finalText is empty", async () => {
    const embedder = stubEmbedder([[1, 0]]);
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "x",
      reference: "ref",
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx(""), embedder);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toBeDefined();
  });

  it("returns score 0 + error when embedder throws", async () => {
    const failing: Embedder = {
      provider: "local",
      model: "stub",
      async embed() {
        throw new Error("nope");
      },
    };
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "x",
      reference: "ref",
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx("hi"), failing);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toContain("nope");
  });

  it("returns score 0 + error when embedder returns wrong vector count", async () => {
    const embedder: Embedder = {
      provider: "local",
      model: "stub",
      async embed() {
        return { vectors: [[1, 0]], tokens: 0 };
      },
    };
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "x",
      references: ["a", "b"],
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx("hi"), embedder);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.score).toBe(0);
    expect(result.outcome.error).toBeDefined();
  });
});

describe("runSemantic — clamping", () => {
  it("score never exceeds 1 even with floating-point drift", async () => {
    const embedder = stubEmbedder([
      [1, 0, 0],
      [1, 0, 0],
    ]);
    const assertion: SemanticAssertion = {
      kind: "semantic",
      name: "x",
      reference: "r",
      mode: "any",
    };
    const result = await runSemantic(assertion, ctx("t"), embedder);
    if (result.outcome.kind !== "semantic") return;
    expect(result.outcome.score).toBeLessThanOrEqual(1);
    expect(result.outcome.score).toBeGreaterThanOrEqual(0);
  });
});
