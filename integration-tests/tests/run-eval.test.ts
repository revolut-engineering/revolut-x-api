import { describe, it, expect } from "vitest";
import { aggregate } from "../src/eval-framework/run-eval.js";
import type {
  AssertionOutcome,
  EvalCase,
  TrialResult,
} from "../src/eval-framework/types.js";

function evalCase(): EvalCase {
  return {
    name: "case1",
    prompt: "p",
    assertions: [
      { kind: "predicate", name: "p1", check: () => true },
      { kind: "judge", name: "j1", criterion: "ok" },
    ],
  };
}

function trial(
  index: number,
  passed: boolean,
  outcomes: AssertionOutcome[],
  overrides: Partial<TrialResult> = {},
): TrialResult {
  return {
    trial: index,
    passed,
    durationMs: 100,
    cost: 0.001,
    judgeCost: 0.0001,
    embeddingCost: 0,
    agent: {
      toolCalls: [],
      finalText: "answer",
      turns: 1,
      stopReason: "end_turn",
      durationMs: 100,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "claude-opus-4-7",
    },
    assertions: outcomes,
    ...overrides,
  };
}

describe("aggregate", () => {
  it("computes pass rate of 1 when all trials pass", () => {
    const trials = [
      trial(0, true, [
        { kind: "predicate", name: "p1", passed: true },
        { kind: "judge", name: "j1", passed: true, score: 0.9 },
      ]),
      trial(1, true, [
        { kind: "predicate", name: "p1", passed: true },
        { kind: "judge", name: "j1", passed: true, score: 0.85 },
      ]),
    ];
    const result = aggregate(evalCase(), trials, 0.667, Date.now());
    expect(result.passRate).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.passes).toBe(2);
    expect(result.trialCount).toBe(2);
  });

  it("marks case failed when pass rate < threshold", () => {
    const trials = [
      trial(0, true, [
        { kind: "predicate", name: "p1", passed: true },
        { kind: "judge", name: "j1", passed: true, score: 0.9 },
      ]),
      trial(1, false, [
        { kind: "predicate", name: "p1", passed: false },
        { kind: "judge", name: "j1", passed: false, score: 0.4 },
      ]),
      trial(2, false, [
        { kind: "predicate", name: "p1", passed: false },
        { kind: "judge", name: "j1", passed: false, score: 0.3 },
      ]),
    ];
    const result = aggregate(evalCase(), trials, 0.667, Date.now());
    expect(result.passRate).toBeCloseTo(1 / 3, 5);
    expect(result.passed).toBe(false);
  });

  it("marks case passed when pass rate equals threshold", () => {
    const trials = [
      trial(0, true, [{ kind: "predicate", name: "p1", passed: true }]),
      trial(1, false, [{ kind: "predicate", name: "p1", passed: false }]),
      trial(2, true, [{ kind: "predicate", name: "p1", passed: true }]),
    ];
    const single: EvalCase = {
      name: "case1",
      prompt: "p",
      assertions: [{ kind: "predicate", name: "p1", check: () => true }],
    };
    const result = aggregate(single, trials, 2 / 3, Date.now());
    expect(result.passRate).toBeCloseTo(2 / 3, 5);
    expect(result.passed).toBe(true);
  });

  it("returns null mean score for predicate-only assertions", () => {
    const trials = [
      trial(0, true, [{ kind: "predicate", name: "p1", passed: true }]),
    ];
    const single: EvalCase = {
      name: "case1",
      prompt: "p",
      assertions: [{ kind: "predicate", name: "p1", check: () => true }],
    };
    const result = aggregate(single, trials, 0.5, Date.now());
    expect(result.assertionMeanScores["p1"]).toBeNull();
  });

  it("computes mean score for judge assertions across trials", () => {
    const trials = [
      trial(0, true, [
        { kind: "predicate", name: "p1", passed: true },
        { kind: "judge", name: "j1", passed: true, score: 0.8 },
      ]),
      trial(1, true, [
        { kind: "predicate", name: "p1", passed: true },
        { kind: "judge", name: "j1", passed: true, score: 0.6 },
      ]),
    ];
    const result = aggregate(evalCase(), trials, 0.5, Date.now());
    expect(result.assertionMeanScores["j1"]).toBeCloseTo(0.7, 5);
  });

  it("clamps non-finite costs in trials to 0 in totals", () => {
    const trials = [
      trial(0, true, [{ kind: "predicate", name: "p1", passed: true }], {
        cost: Number.NaN,
        judgeCost: Number.POSITIVE_INFINITY,
        embeddingCost: -1,
      }),
    ];
    const single: EvalCase = {
      name: "case1",
      prompt: "p",
      assertions: [{ kind: "predicate", name: "p1", check: () => true }],
    };
    // Aggregate accepts the trial as-is but sumNonNegative pattern keeps totals sensible.
    const result = aggregate(single, trials, 0.5, Date.now());
    expect(result.totalCost).toBe(0);
    expect(result.totalJudgeCost).toBe(0);
    expect(result.totalEmbeddingCost).toBe(0);
  });

  it("handles empty trials without dividing by zero", () => {
    const single: EvalCase = {
      name: "case1",
      prompt: "p",
      assertions: [{ kind: "predicate", name: "p1", check: () => true }],
    };
    const result = aggregate(single, [], 0.5, Date.now());
    expect(result.passRate).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.assertionPassRates["p1"]).toBe(0);
    expect(result.assertionMeanScores["p1"]).toBeNull();
  });

  it("clamps passRate and threshold to [0, 1]", () => {
    const single: EvalCase = {
      name: "case1",
      prompt: "p",
      assertions: [{ kind: "predicate", name: "p1", check: () => true }],
    };
    const trials = [
      trial(0, true, [{ kind: "predicate", name: "p1", passed: true }]),
    ];
    const result = aggregate(single, trials, 1, Date.now());
    expect(result.passRate).toBeLessThanOrEqual(1);
    expect(result.threshold).toBeLessThanOrEqual(1);
    expect(result.threshold).toBeGreaterThanOrEqual(0);
  });
});
