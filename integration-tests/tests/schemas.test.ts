import { describe, it, expect } from "vitest";
import {
  AssertionSchema,
  EvalCaseSchema,
  JudgeResponseSchema,
  RunReportSchema,
} from "../src/eval-framework/schemas.js";

describe("EvalCaseSchema", () => {
  it("accepts a minimal valid case", () => {
    const result = EvalCaseSchema.safeParse({
      name: "case1",
      prompt: "what?",
      assertions: [{ name: "x", check: () => true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = EvalCaseSchema.safeParse({
      name: "",
      prompt: "what?",
      assertions: [{ name: "x", check: () => true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty assertions array", () => {
    const result = EvalCaseSchema.safeParse({
      name: "case1",
      prompt: "what?",
      assertions: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects threshold > 1", () => {
    const result = EvalCaseSchema.safeParse({
      name: "case1",
      prompt: "what?",
      passThreshold: 1.5,
      assertions: [{ name: "x", check: () => true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative trial count", () => {
    const result = EvalCaseSchema.safeParse({
      name: "case1",
      prompt: "what?",
      trials: -1,
      assertions: [{ name: "x", check: () => true }],
    });
    expect(result.success).toBe(false);
  });
});

describe("AssertionSchema (semantic)", () => {
  it("accepts reference (not references)", () => {
    const result = AssertionSchema.safeParse({
      kind: "semantic",
      name: "x",
      reference: "hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts references (not reference)", () => {
    const result = AssertionSchema.safeParse({
      kind: "semantic",
      name: "x",
      references: ["a", "b"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects both reference and references", () => {
    const result = AssertionSchema.safeParse({
      kind: "semantic",
      name: "x",
      reference: "hi",
      references: ["a", "b"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects neither reference nor references", () => {
    const result = AssertionSchema.safeParse({
      kind: "semantic",
      name: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty references array", () => {
    const result = AssertionSchema.safeParse({
      kind: "semantic",
      name: "x",
      references: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("AssertionSchema (judge)", () => {
  it("accepts a minimal judge assertion", () => {
    const result = AssertionSchema.safeParse({
      kind: "judge",
      name: "j1",
      criterion: "answer is correct",
    });
    expect(result.success).toBe(true);
  });

  it("rejects threshold out of range", () => {
    const result = AssertionSchema.safeParse({
      kind: "judge",
      name: "j1",
      criterion: "answer is correct",
      threshold: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("JudgeResponseSchema", () => {
  it("accepts a valid response", () => {
    const result = JudgeResponseSchema.safeParse({
      score: 0.7,
      reasoning: "looks good",
    });
    expect(result.success).toBe(true);
  });

  it("rejects score > 1", () => {
    const result = JudgeResponseSchema.safeParse({
      score: 1.2,
      reasoning: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects score < 0", () => {
    const result = JudgeResponseSchema.safeParse({
      score: -0.1,
      reasoning: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reasoning", () => {
    const result = JudgeResponseSchema.safeParse({
      score: 0.5,
      reasoning: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects NaN score", () => {
    const result = JudgeResponseSchema.safeParse({
      score: Number.NaN,
      reasoning: "ok",
    });
    expect(result.success).toBe(false);
  });
});

describe("RunReportSchema", () => {
  it("rejects NaN totalCost", () => {
    const result = RunReportSchema.safeParse({
      metadata: {
        runId: "x",
        startedAt: "now",
        model: "m",
        judgeModel: "j",
        embeddingProvider: "local",
        embeddingModel: "local",
        repetitions: 1,
        passThreshold: 0.5,
      },
      results: [],
      totalCost: Number.NaN,
      totalJudgeCost: 0,
      totalEmbeddingCost: 0,
      totalDurationMs: 0,
      passed: 0,
      failed: 0,
      totalCases: 0,
    });
    expect(result.success).toBe(false);
  });
});
