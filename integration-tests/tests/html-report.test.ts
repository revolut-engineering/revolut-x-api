import { describe, expect, it } from "vitest";
import {
  renderIndexHtml,
  renderRunHtml,
  type RunIndexEntry,
} from "../src/eval-framework/html-report.js";
import type {
  AssertionOutcome,
  EvalResult,
  RunReport,
  TrialResult,
} from "../src/eval-framework/schemas.js";

function makeOutcome(overrides: Partial<AssertionOutcome>): AssertionOutcome {
  return {
    kind: "predicate",
    name: "p",
    passed: true,
    ...(overrides as Record<string, unknown>),
  } as AssertionOutcome;
}

function makeTrial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    trial: 0,
    passed: true,
    durationMs: 1234,
    cost: 0.012,
    judgeCost: 0.001,
    embeddingCost: 0,
    agent: {
      toolCalls: [
        {
          name: "get_balances",
          args: { foo: "bar" },
          result: { content: [], isError: false },
          turn: 0,
        },
      ],
      finalText: "BTC: 1.5\nUSD: 10000",
      turns: 1,
      stopReason: "end_turn",
      durationMs: 1234,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: "claude-opus-4-7",
    },
    assertions: [
      makeOutcome({
        kind: "predicate",
        name: "calls get_balances",
        passed: true,
      }),
      makeOutcome({
        kind: "judge",
        name: "answer is correct",
        passed: true,
        score: 0.85,
        reasoning: "all numbers correct",
      }),
      makeOutcome({
        kind: "semantic",
        name: "matches reference",
        passed: false,
        score: 0.62,
        reasoning: "max sim 0.620",
      }),
    ],
    ...overrides,
  };
}

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  const trials = [makeTrial()];
  return {
    name: "balances-snapshot",
    description: "Account balances retrieval",
    prompt: "What's in my account?",
    trials,
    trialCount: trials.length,
    passes: 1,
    passRate: 1,
    threshold: 0.667,
    passed: true,
    durationMs: 1234,
    totalCost: 0.012,
    totalJudgeCost: 0.001,
    totalEmbeddingCost: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    assertionPassRates: {
      "calls get_balances": 1,
      "answer is correct": 1,
      "matches reference": 0,
    },
    assertionMeanScores: {
      "calls get_balances": null,
      "answer is correct": 0.85,
      "matches reference": 0.62,
    },
    ...overrides,
  };
}

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  const results = [makeResult()];
  return {
    metadata: {
      runId: "2026-04-28T13-00-00-000",
      startedAt: "2026-04-28T13:00:00.000Z",
      finishedAt: "2026-04-28T13:01:30.000Z",
      model: "claude-opus-4-7",
      judgeModel: "claude-sonnet-4-6",
      embeddingProvider: "local",
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      repetitions: 3,
      passThreshold: 0.667,
    },
    results,
    totalCost: 0.012,
    totalJudgeCost: 0.001,
    totalEmbeddingCost: 0,
    totalDurationMs: 90_000,
    passed: 1,
    failed: 0,
    totalCases: 1,
    ...overrides,
  };
}

describe("renderRunHtml — dates", () => {
  it("renders ISO startedAt as 'YYYY-MM-DD HH:MM:SS UTC'", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("2026-04-28 13:00:00 UTC");
  });

  it("renders ISO finishedAt as formatted UTC", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("2026-04-28 13:01:30 UTC");
  });

  it("does not leak the raw ISO 'T' separator into the rendered date column", () => {
    const html = renderRunHtml(makeReport());
    const startedSection = html.split("<dt>Started</dt>")[1] ?? "";
    const dd = startedSection.split("</dd>")[0] ?? "";
    expect(dd).not.toMatch(/\dT\d/);
  });

  it("omits the Finished row when finishedAt is undefined", () => {
    const report = makeReport();
    const without: RunReport = {
      ...report,
      metadata: { ...report.metadata, finishedAt: undefined },
    };
    const html = renderRunHtml(without);
    expect(html).not.toContain("<dt>Finished</dt>");
  });
});

describe("renderRunHtml — totals & costs", () => {
  it("renders the cost split with 4 decimals", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("$0.0120 · $0.0010 · $0.0000");
  });

  it("renders pass count as N/M", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("1/1");
  });

  it("renders threshold as a percentage", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("threshold 67%");
  });
});

describe("renderRunHtml — assertions and scores", () => {
  it("renders judge score with 3 decimals", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("0.850");
  });

  it("renders semantic score with 3 decimals", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain("0.620");
  });

  it("does not render mean-score for predicate-only assertions", () => {
    const html = renderRunHtml(makeReport());
    const summary = html.split("calls get_balances")[1] ?? "";
    const upToBar = summary.split('<div class="bar">')[0] ?? "";
    expect(upToBar).not.toContain("mean score");
  });

  it("renders a FAIL pill when a trial assertion failed", () => {
    const html = renderRunHtml(makeReport());
    expect(html).toContain('class="pill fail">FAIL');
  });
});

describe("renderRunHtml — escaping", () => {
  it("escapes HTML special characters in case names and prompts", () => {
    const report = makeReport();
    report.results[0].name = "<script>alert(1)</script>";
    report.results[0].prompt = "</pre><x>";
    const html = renderRunHtml(report);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;/pre&gt;&lt;x&gt;");
  });
});

describe("renderRunHtml — empty/edge", () => {
  it("renders cleanly with zero results", () => {
    const html = renderRunHtml(
      makeReport({ results: [], totalCases: 0, passed: 0 }),
    );
    expect(html).toContain("Eval run");
  });
});

describe("renderIndexHtml", () => {
  it("renders dates formatted as UTC", () => {
    const entries: RunIndexEntry[] = [
      {
        runId: "run-a",
        startedAt: "2026-04-28T09:00:00.000Z",
        model: "claude-opus-4-7",
        judgeModel: "claude-sonnet-4-6",
        embeddingProvider: "local",
        passed: 5,
        total: 6,
        totalCost: 1.234,
        durationMs: 60_000,
        reportPath: "run-a/report.html",
      },
    ];
    const html = renderIndexHtml(entries);
    expect(html).toContain("2026-04-28 09:00:00 UTC");
  });

  it("sorts newest first", () => {
    const entries: RunIndexEntry[] = [
      {
        runId: "old",
        startedAt: "2025-01-01T00:00:00Z",
        model: "x",
        judgeModel: "x",
        embeddingProvider: "local",
        passed: 0,
        total: 0,
        totalCost: 0,
        durationMs: 0,
        reportPath: "old/report.html",
      },
      {
        runId: "new",
        startedAt: "2026-04-28T00:00:00Z",
        model: "x",
        judgeModel: "x",
        embeddingProvider: "local",
        passed: 0,
        total: 0,
        totalCost: 0,
        durationMs: 0,
        reportPath: "new/report.html",
      },
    ];
    const html = renderIndexHtml(entries);
    const newPos = html.indexOf("run-id-new");
    const oldPos = html.indexOf("run-id-old");
    expect(html.indexOf(">new<")).toBeGreaterThan(-1);
    expect(html.indexOf(">old<")).toBeGreaterThan(-1);
    expect(html.indexOf(">new<")).toBeLessThan(html.indexOf(">old<"));
    void newPos;
    void oldPos;
  });

  it("renders 'No runs yet.' when empty", () => {
    const html = renderIndexHtml([]);
    expect(html).toContain("No runs yet");
  });
});
