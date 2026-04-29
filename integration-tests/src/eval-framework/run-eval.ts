import { it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createHarness } from "../harness/create-harness.js";
import type { Harness } from "../harness/create-harness.js";
import {
  EvalCaseSchema,
  type Assertion,
  type AssertionContext,
  type AssertionKind,
  type AssertionOutcome,
  type EvalCase,
  type EvalResult,
  type PredicateAssertion,
  type TrialResult,
} from "./schemas.js";
import { getEvalConfig } from "./config.js";
import { estimateCostUsd } from "./pricing.js";
import { recordEvalResult } from "./reporter.js";
import { runJudge } from "./judge.js";
import { runSemantic } from "./semantic.js";
import { getEmbedder, type Embedder } from "./embeddings.js";
import { fmt } from "./format.js";
import { logger } from "./logger.js";
import { EvalConfigError, serializeError } from "./errors.js";

export function defineEval(rawCase: EvalCase): void {
  const parsed = EvalCaseSchema.safeParse(rawCase);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new EvalConfigError(
      `defineEval: invalid case "${rawCase?.name ?? "<unnamed>"}" — ${issues}`,
      { issues: parsed.error.issues },
    );
  }
  const evalCase = parsed.data;

  const config = getEvalConfig();
  const trialCount = evalCase.trials ?? config.repetitions;
  const passThreshold = evalCase.passThreshold ?? config.passThreshold;
  const model = evalCase.model ?? config.model;

  it(`${evalCase.name} (${trialCount} trials, threshold ${fmt.threshold(passThreshold)})`, async () => {
    const trials: TrialResult[] = [];
    const startedAt = Date.now();

    for (let i = 0; i < trialCount; i++) {
      const trial = await runTrial(evalCase, i, model);
      trials.push(trial);
    }

    const result = aggregate(evalCase, trials, passThreshold, startedAt);
    await recordEvalResult(result);
    assertPassed(result);
  });
}

async function runTrial(
  evalCase: EvalCase,
  trialIndex: number,
  model: string,
): Promise<TrialResult> {
  const trialStartedAt = Date.now();
  let harness: Harness | null = null;

  try {
    harness = await createHarness();
    if (evalCase.setup) {
      await evalCase.setup();
    }

    const agent = await harness.runAgent({
      prompt: evalCase.prompt,
      systemPrompt: evalCase.systemPrompt,
      model,
      maxIterations: evalCase.maxIterations,
    });

    const ctx: AssertionContext = { ...agent, prompt: evalCase.prompt };
    const evaluated = await evaluateAssertions(
      evalCase.assertions,
      ctx,
      harness.anthropic,
    );

    const passed = evaluated.outcomes.every((a) => a.passed);
    const cost = estimateCostUsd(model, agent.usage);

    return {
      trial: trialIndex,
      passed,
      durationMs: Date.now() - trialStartedAt,
      agent,
      assertions: evaluated.outcomes,
      cost: nonNegFinite(cost),
      judgeCost: nonNegFinite(evaluated.judgeCost),
      embeddingCost: nonNegFinite(evaluated.embeddingCost),
    };
  } catch (error) {
    return {
      trial: trialIndex,
      passed: false,
      durationMs: Date.now() - trialStartedAt,
      agent: {
        toolCalls: [],
        finalText: "",
        turns: 0,
        stopReason: "error",
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
      },
      assertions: [],
      cost: 0,
      judgeCost: 0,
      embeddingCost: 0,
      error: JSON.stringify(serializeError(error)),
    };
  } finally {
    if (harness) await harness.close();
  }
}

interface EvaluatedAssertions {
  outcomes: AssertionOutcome[];
  judgeCost: number;
  embeddingCost: number;
}

async function evaluateAssertions(
  assertions: Assertion[],
  ctx: AssertionContext,
  anthropic: Anthropic,
): Promise<EvaluatedAssertions> {
  const config = getEvalConfig();
  const outcomes: AssertionOutcome[] = [];
  let judgeCost = 0;
  let embeddingCost = 0;
  let lazyEmbedder: Embedder | null = null;

  for (const assertion of assertions) {
    const kind = resolveKind(assertion);

    if (kind === "predicate") {
      outcomes.push(await runPredicate(assertion as PredicateAssertion, ctx));
      continue;
    }

    if (kind === "judge") {
      const result = await runJudge(
        assertion as Extract<Assertion, { kind: "judge" }>,
        ctx,
        anthropic,
        config.judgeModel,
        config.judgeMaxTokens,
      );
      outcomes.push(result.outcome);
      judgeCost += nonNegFinite(result.cost);
      continue;
    }

    if (kind === "semantic") {
      if (!lazyEmbedder) {
        lazyEmbedder = getEmbedder({
          provider: config.embeddingProvider,
          model: config.embeddingModel,
        });
      }
      const result = await runSemantic(
        assertion as Extract<Assertion, { kind: "semantic" }>,
        ctx,
        lazyEmbedder,
      );
      outcomes.push(result.outcome);
      embeddingCost += nonNegFinite(result.cost);
      continue;
    }
  }

  return { outcomes, judgeCost, embeddingCost };
}

function resolveKind(assertion: Assertion): AssertionKind {
  if ("kind" in assertion && assertion.kind) return assertion.kind;
  return "predicate";
}

async function runPredicate(
  assertion: PredicateAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  try {
    const passed = await assertion.check(ctx);
    return { name: assertion.name, kind: "predicate", passed };
  } catch (error) {
    return {
      name: assertion.name,
      kind: "predicate",
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function aggregate(
  evalCase: EvalCase,
  trials: TrialResult[],
  passThreshold: number,
  startedAt: number,
): EvalResult {
  const passes = trials.filter((t) => t.passed).length;
  const passRate = trials.length === 0 ? 0 : passes / trials.length;
  const totalCost = nonNegFinite(trials.reduce((sum, t) => sum + t.cost, 0));
  const totalJudgeCost = nonNegFinite(
    trials.reduce((sum, t) => sum + t.judgeCost, 0),
  );
  const totalEmbeddingCost = nonNegFinite(
    trials.reduce((sum, t) => sum + t.embeddingCost, 0),
  );
  const totalInput = nonNegFinite(
    trials.reduce((sum, t) => sum + t.agent.usage.inputTokens, 0),
  );
  const totalOutput = nonNegFinite(
    trials.reduce((sum, t) => sum + t.agent.usage.outputTokens, 0),
  );

  const assertionPassRates: Record<string, number> = {};
  const assertionMeanScores: Record<string, number | null> = {};
  for (const assertion of evalCase.assertions) {
    const evaluated = trials
      .map((t) => t.assertions.find((a) => a.name === assertion.name))
      .filter((a): a is AssertionOutcome => Boolean(a));
    if (evaluated.length === 0) {
      assertionPassRates[assertion.name] = 0;
      assertionMeanScores[assertion.name] = null;
      continue;
    }
    const passed = evaluated.filter((a) => a.passed).length;
    assertionPassRates[assertion.name] = clampUnit(passed / evaluated.length);

    const scores = evaluated
      .map((a) => (a.kind === "predicate" ? undefined : a.score))
      .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
    assertionMeanScores[assertion.name] =
      scores.length === 0
        ? null
        : clampUnit(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  return {
    name: evalCase.name,
    description: evalCase.description,
    prompt: evalCase.prompt,
    trials,
    trialCount: trials.length,
    passes,
    passRate: clampUnit(passRate),
    threshold: clampUnit(passThreshold),
    passed: passRate >= passThreshold,
    durationMs: Math.max(0, Date.now() - startedAt),
    totalCost,
    totalJudgeCost,
    totalEmbeddingCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    assertionPassRates,
    assertionMeanScores,
  };
}

function nonNegFinite(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function assertPassed(result: EvalResult): void {
  if (result.passed) return;

  const lines = buildFailureMessage(result);
  logger.warn(`eval case failed: ${result.name}`, {
    passRate: result.passRate,
    threshold: result.threshold,
    strict: getEvalConfig().strict,
  });
  if (getEvalConfig().strict) {
    expect.fail(lines.join("\n"));
    return;
  }
  console.warn(`\n${lines.join("\n")}\n`);
}

function buildFailureMessage(result: EvalResult): string[] {
  const lines = [
    `Eval "${result.name}" did not meet threshold: pass rate ${fmt.pct(result.passRate)} < threshold ${fmt.threshold(result.threshold)}`,
    `  ${result.passes}/${result.trialCount} trials passed`,
    "  Per-assertion pass rates:",
  ];
  for (const [name, rate] of Object.entries(result.assertionPassRates)) {
    const score = result.assertionMeanScores[name];
    const scorePart =
      typeof score === "number"
        ? ` (mean score ${formatPreciseScore(score)})`
        : "";
    lines.push(`    ${name}: ${fmt.pct(rate)}${scorePart}`);
  }
  for (const trial of result.trials) {
    if (!trial.passed) {
      const failed = trial.assertions
        .filter((a) => !a.passed)
        .map((a) => {
          const score = a.kind === "predicate" ? undefined : a.score;
          const scoreStr =
            typeof score === "number"
              ? ` (score ${formatPreciseScore(score)})`
              : "";
          const errStr = a.error ? ` (${a.error.split("\n")[0]})` : "";
          return `${a.name}${scoreStr}${errStr}`;
        })
        .join(", ");
      lines.push(
        `  Trial ${trial.trial}: ${
          trial.error ? `ERROR: ${trial.error.split("\n")[0]}` : failed
        }`,
      );
    }
  }
  return lines;
}

function formatPreciseScore(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(4);
}
