import { describe, it, expect } from "vitest";
import {
  escapeXml,
  renderJunit,
  renderMarkdown,
} from "../src/eval-framework/reporter.js";
import type {
  EvalResult,
  RunReport,
  TrialResult,
} from "../src/eval-framework/schemas.js";

function trial(passed: boolean, name: string): TrialResult {
  return {
    trial: 0,
    passed,
    durationMs: 1234,
    cost: 0.01,
    judgeCost: 0.001,
    embeddingCost: 0,
    agent: {
      toolCalls: [
        {
          name: "get_balances",
          args: {},
          result: { content: [], isError: false },
          turn: 0,
        },
      ],
      finalText: "answer",
      turns: 1,
      stopReason: "end_turn",
      durationMs: 1234,
      usage: { inputTokens: 50, outputTokens: 25 },
      model: "claude-opus-4-7",
    },
    assertions: passed
      ? [{ kind: "predicate", name, passed: true }]
      : [
          { kind: "predicate", name: `${name}-A`, passed: false },
          { kind: "judge", name: `${name}-B`, passed: false, score: 0.5 },
        ],
  };
}

function result(passed: boolean, name = "case-A"): EvalResult {
  const t = trial(passed, name);
  return {
    name,
    description: "desc",
    prompt: "what?",
    trials: [t],
    trialCount: 1,
    passes: passed ? 1 : 0,
    passRate: passed ? 1 : 0,
    threshold: 0.667,
    passed,
    durationMs: 1234,
    totalCost: 0.01,
    totalJudgeCost: 0.001,
    totalEmbeddingCost: 0,
    totalInputTokens: 50,
    totalOutputTokens: 25,
    assertionPassRates: passed
      ? { [name]: 1 }
      : { [`${name}-A`]: 0, [`${name}-B`]: 0 },
    assertionMeanScores: passed
      ? { [name]: null }
      : { [`${name}-A`]: null, [`${name}-B`]: 0.5 },
  };
}

function makeReport(results: EvalResult[]): RunReport {
  const passed = results.filter((r) => r.passed).length;
  return {
    metadata: {
      runId: "rid",
      startedAt: "2026-04-28T12:00:00.000Z",
      finishedAt: "2026-04-28T12:01:00.000Z",
      model: "claude-opus-4-7",
      judgeModel: "claude-sonnet-4-6",
      embeddingProvider: "local",
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      repetitions: 1,
      passThreshold: 0.667,
    },
    results,
    totalCost: 0.01 * results.length,
    totalJudgeCost: 0.001 * results.length,
    totalEmbeddingCost: 0,
    totalDurationMs: 1234 * results.length,
    passed,
    failed: results.length - passed,
    totalCases: results.length,
  };
}

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml("a&b<c>d\"e'")).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;");
  });
});

describe("renderJunit", () => {
  it("emits no <failure> for passing cases", () => {
    const xml = renderJunit(makeReport([result(true)]));
    expect(xml).toContain("<testcase");
    expect(xml).not.toContain("<failure");
  });

  it("emits <failure> with details for failing cases", () => {
    const xml = renderJunit(makeReport([result(false)]));
    expect(xml).toContain("<failure");
    expect(xml).toContain("pass rate 0%");
    expect(xml).toContain("threshold 67%");
  });

  it("includes the test count and failure count in the suite", () => {
    const xml = renderJunit(makeReport([result(true), result(false, "x")]));
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
  });

  it("escapes case names containing XML specials", () => {
    const r = result(false, "<bad>");
    const xml = renderJunit(makeReport([r]));
    expect(xml).not.toContain('<testcase classname="eval" name="<bad>"');
    expect(xml).toContain("&lt;bad&gt;");
  });
});

describe("renderMarkdown", () => {
  it("contains the run id, models, embedder", () => {
    const md = renderMarkdown(makeReport([result(true)]));
    expect(md).toContain("# Eval run rid");
    expect(md).toContain("claude-opus-4-7");
    expect(md).toContain("claude-sonnet-4-6");
    expect(md).toContain("local");
    expect(md).toContain("Xenova/all-MiniLM-L6-v2");
  });

  it("uses formatted UTC timestamps", () => {
    const md = renderMarkdown(makeReport([result(true)]));
    expect(md).toContain("2026-04-28 12:00:00 UTC");
    expect(md).toContain("2026-04-28 12:01:00 UTC");
  });

  it("renders status PASS/FAIL prefix per case", () => {
    const md = renderMarkdown(
      makeReport([result(true, "good"), result(false, "bad")]),
    );
    expect(md).toContain("PASS good");
    expect(md).toContain("FAIL bad");
  });

  it("includes per-assertion pass rates section", () => {
    const md = renderMarkdown(makeReport([result(false, "x")]));
    expect(md).toContain("## Per-assertion pass rates");
    expect(md).toContain("### x");
    expect(md).toContain("x-A: 0%");
  });

  it("renders judge mean score with 3 decimals", () => {
    const md = renderMarkdown(makeReport([result(false, "x")]));
    expect(md).toContain("mean score 0.500");
  });

  it("formats costs with 4 decimals", () => {
    const md = renderMarkdown(makeReport([result(true)]));
    expect(md).toContain("$0.0100");
    expect(md).toContain("$0.0010");
  });
});
