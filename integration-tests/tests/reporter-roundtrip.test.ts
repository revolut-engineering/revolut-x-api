import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeRunReport,
  initRunReport,
  recordEvalResult,
} from "../src/eval-framework/reporter.js";
import { resetEvalConfigForTesting } from "../src/eval-framework/config.js";
import type { EvalResult } from "../src/eval-framework/schemas.js";

let runDir: string;

const ENV_KEYS = [
  "EVAL_REPETITIONS",
  "EVAL_PASS_THRESHOLD",
  "EVAL_RUN_ID",
  "EVAL_REPORT_DIR",
  "EVAL_MODEL",
  "EVAL_COST_CAP_USD",
  "EVAL_JUDGE_MODEL",
  "EVAL_JUDGE_MAX_TOKENS",
  "EVAL_EMBEDDING_PROVIDER",
  "EVAL_EMBEDDING_MODEL",
  "OPENAI_API_KEY",
];
const snap: Record<string, string | undefined> = {};

function captureEnv() {
  for (const k of ENV_KEYS) snap[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function makeResult(name: string, passed: boolean): EvalResult {
  return {
    name,
    description: `${name} desc`,
    prompt: "what?",
    trials: [
      {
        trial: 0,
        passed,
        durationMs: 1000,
        cost: 0.01,
        judgeCost: 0,
        embeddingCost: 0,
        agent: {
          toolCalls: [],
          finalText: "answer",
          turns: 1,
          stopReason: "end_turn",
          durationMs: 1000,
          usage: { inputTokens: 50, outputTokens: 25 },
          model: "claude-opus-4-7",
        },
        assertions: [{ kind: "predicate", name: "p", passed }],
      },
    ],
    trialCount: 1,
    passes: passed ? 1 : 0,
    passRate: passed ? 1 : 0,
    threshold: 0.667,
    passed,
    durationMs: 1000,
    totalCost: 0.01,
    totalJudgeCost: 0,
    totalEmbeddingCost: 0,
    totalInputTokens: 50,
    totalOutputTokens: 25,
    assertionPassRates: { p: passed ? 1 : 0 },
    assertionMeanScores: { p: null },
  };
}

describe("reporter round-trip", () => {
  beforeEach(async () => {
    captureEnv();
    const parent = await mkdtemp(join(tmpdir(), "eval-reporter-"));
    runDir = join(parent, "run-test");
    process.env.EVAL_RUN_ID = "test";
    process.env.EVAL_REPORT_DIR = runDir;
    process.env.EVAL_EMBEDDING_PROVIDER = "local";
    delete process.env.OPENAI_API_KEY;
    resetEvalConfigForTesting();
  });

  afterEach(async () => {
    if (runDir) {
      await rm(join(runDir, ".."), { recursive: true, force: true });
    }
    restoreEnv();
    resetEvalConfigForTesting();
  });

  it("initRunReport creates the dir and metadata.json", async () => {
    const meta = await initRunReport();
    expect(meta.runId).toBe("test");
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
  });

  it("recordEvalResult appends to results.jsonl and trials.jsonl", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("case-A", true));
    await recordEvalResult(makeResult("case-B", false));
    const results = await readFile(join(runDir, "results.jsonl"), "utf8");
    const trials = await readFile(join(runDir, "trials.jsonl"), "utf8");
    expect(results.split("\n").filter(Boolean)).toHaveLength(2);
    expect(trials.split("\n").filter(Boolean)).toHaveLength(2);
    expect(results).toContain("case-A");
    expect(results).toContain("case-B");
  });

  it("finalizeRunReport writes summary.json + junit.xml + report.md + report.html", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("case-A", true));
    await recordEvalResult(makeResult("case-B", false));
    const report = await finalizeRunReport();
    expect(report).not.toBeNull();
    expect(report?.totalCases).toBe(2);
    expect(report?.passed).toBe(1);
    expect(report?.failed).toBe(1);
    expect(existsSync(join(runDir, "summary.json"))).toBe(true);
    expect(existsSync(join(runDir, "junit.xml"))).toBe(true);
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
    expect(existsSync(join(runDir, "report.html"))).toBe(true);
  });

  it("finalizeRunReport rebuilds the cross-run index.html", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("case-A", true));
    await finalizeRunReport();
    const indexPath = join(runDir, "..", "index.html");
    expect(existsSync(indexPath)).toBe(true);
    const html = await readFile(indexPath, "utf8");
    expect(html).toContain("test");
  });

  it("readResults skips malformed JSON lines without aborting", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("good", true));
    const resultsPath = join(runDir, "results.jsonl");
    const existing = await readFile(resultsPath, "utf8");
    await writeFile(resultsPath, existing + "{not valid json}\n", "utf8");
    const report = await finalizeRunReport();
    expect(report?.totalCases).toBe(1);
  });

  it("readResults skips lines failing schema validation", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("good", true));
    const resultsPath = join(runDir, "results.jsonl");
    const existing = await readFile(resultsPath, "utf8");
    await writeFile(
      resultsPath,
      existing + JSON.stringify({ name: "bad" }) + "\n",
      "utf8",
    );
    const report = await finalizeRunReport();
    expect(report?.totalCases).toBe(1);
  });

  it("rebuildIndex skips runs with malformed summary.json", async () => {
    await initRunReport();
    await recordEvalResult(makeResult("good", true));
    const parent = join(runDir, "..");
    const badRun = join(parent, "run-broken");
    await mkdir(badRun, { recursive: true });
    await writeFile(join(badRun, "summary.json"), "{not json", "utf8");
    await finalizeRunReport();
    const indexHtml = await readFile(join(parent, "index.html"), "utf8");
    expect(indexHtml).not.toContain("run-broken");
  });

  it("returns null from finalizeRunReport when metadata.json is absent", async () => {
    const report = await finalizeRunReport();
    expect(report).toBeNull();
  });
});
