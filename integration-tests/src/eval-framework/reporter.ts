import {
  mkdir,
  appendFile,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  EvalResultSchema,
  RunReportSchema,
  type EvalResult,
  type RunMetadata,
  type RunReport,
} from "./schemas.js";
import { getEvalConfig } from "./config.js";
import { fmt } from "./format.js";
import { logger } from "./logger.js";
import {
  renderRunHtml,
  renderIndexHtml,
  type RunIndexEntry,
} from "./html-report.js";

const TRIALS_FILE = "trials.jsonl";
const RESULTS_FILE = "results.jsonl";
const METADATA_FILE = "metadata.json";

export async function initRunReport(): Promise<RunMetadata> {
  const config = getEvalConfig();
  await mkdir(config.reportDir, { recursive: true });
  const metadata: RunMetadata = {
    runId: config.runId,
    startedAt: new Date().toISOString(),
    model: config.model,
    judgeModel: config.judgeModel,
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    repetitions: config.repetitions,
    passThreshold: config.passThreshold,
  };
  await writeFile(
    join(config.reportDir, METADATA_FILE),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );
  return metadata;
}

export async function recordEvalResult(result: EvalResult): Promise<void> {
  const config = getEvalConfig();
  const trialsPath = join(config.reportDir, TRIALS_FILE);
  const resultsPath = join(config.reportDir, RESULTS_FILE);

  await appendFile(resultsPath, JSON.stringify(result) + "\n", "utf8");

  for (const trial of result.trials) {
    const record = {
      runId: config.runId,
      case: result.name,
      trial: trial.trial,
      passed: trial.passed,
      durationMs: trial.durationMs,
      cost: trial.cost,
      judgeCost: trial.judgeCost,
      embeddingCost: trial.embeddingCost,
      prompt: result.prompt,
      toolCalls: trial.agent.toolCalls.map((c) => ({
        name: c.name,
        args: c.args,
        turn: c.turn,
      })),
      finalText: trial.agent.finalText,
      stopReason: trial.agent.stopReason,
      turns: trial.agent.turns,
      usage: trial.agent.usage,
      model: trial.agent.model,
      assertions: trial.assertions,
      error: trial.error,
    };
    await appendFile(trialsPath, JSON.stringify(record) + "\n", "utf8");
  }
}

export async function finalizeRunReport(): Promise<RunReport | null> {
  const config = getEvalConfig();
  const metadataPath = join(config.reportDir, METADATA_FILE);
  const resultsPath = join(config.reportDir, RESULTS_FILE);

  if (!existsSync(metadataPath)) return null;

  let metadata: RunMetadata;
  try {
    const raw = await readFile(metadataPath, "utf8");
    metadata = JSON.parse(raw) as RunMetadata;
  } catch (error) {
    logger.warn("metadata.json unreadable", {
      path: metadataPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  metadata.finishedAt = new Date().toISOString();

  const results = await readResults(resultsPath);

  const totalCost = sumNonNegative(results.map((r) => r.totalCost));
  const totalJudgeCost = sumNonNegative(results.map((r) => r.totalJudgeCost));
  const totalEmbeddingCost = sumNonNegative(
    results.map((r) => r.totalEmbeddingCost),
  );
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDurationMs = sumNonNegative(results.map((r) => r.durationMs));

  const report: RunReport = {
    metadata,
    results,
    totalCost,
    totalJudgeCost,
    totalEmbeddingCost,
    totalDurationMs,
    passed,
    failed,
    totalCases: results.length,
  };

  await Promise.all([
    writeFile(
      join(config.reportDir, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    ),
    writeFile(join(config.reportDir, "junit.xml"), renderJunit(report), "utf8"),
    writeFile(
      join(config.reportDir, "report.md"),
      renderMarkdown(report),
      "utf8",
    ),
    writeFile(
      join(config.reportDir, "report.html"),
      renderRunHtml(report),
      "utf8",
    ),
  ]);

  await rebuildIndex(dirname(config.reportDir));

  const grandTotal = totalCost + totalJudgeCost + totalEmbeddingCost;
  if (grandTotal > config.costCapUsd) {
    logger.warn("cost cap exceeded", {
      grandTotal,
      cap: config.costCapUsd,
    });
  }

  return report;
}

async function readResults(resultsPath: string): Promise<EvalResult[]> {
  if (!existsSync(resultsPath)) return [];
  const raw = await readFile(resultsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const results: EvalResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      logger.warn("results.jsonl: malformed JSON, skipping line", {
        lineNumber: i + 1,
        path: resultsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const parsed = EvalResultSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("results.jsonl: line failed schema validation, skipping", {
        lineNumber: i + 1,
        path: resultsPath,
        issues: parsed.error.issues,
      });
      continue;
    }
    results.push(parsed.data);
  }
  return results;
}

function sumNonNegative(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v >= 0) sum += v;
  }
  return sum;
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJunit(report: RunReport): string {
  const totalTime = (report.totalDurationMs / 1000).toFixed(3);
  const cases = report.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const failureBody = r.passed
        ? ""
        : `      <failure message="pass rate ${fmt.pct(r.passRate)} &lt; threshold ${fmt.threshold(r.threshold)}">${escapeXml(
            r.trials
              .filter((t) => !t.passed)
              .map((t) => {
                const failedAssertions = t.assertions
                  .filter((a) => !a.passed)
                  .map((a) => {
                    const score = a.kind === "predicate" ? undefined : a.score;
                    return `${a.name}${typeof score === "number" ? ` (score ${fmt.score(score)})` : ""}`;
                  })
                  .join(", ");
                return `Trial ${t.trial}: ${t.error ?? failedAssertions}`;
              })
              .join("\n"),
          )}</failure>\n`;
      return `    <testcase classname="eval" name="${escapeXml(r.name)}" time="${time}">\n${failureBody}    </testcase>`;
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${report.totalCases}" failures="${report.failed}" time="${totalTime}">\n` +
    `  <testsuite name="agent-evals" tests="${report.totalCases}" failures="${report.failed}" time="${totalTime}">\n` +
    `${cases}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

export function renderMarkdown(report: RunReport): string {
  const meta = report.metadata;
  const lines: string[] = [];
  lines.push(`# Eval run ${meta.runId}`);
  lines.push("");
  lines.push(`- Agent model: \`${meta.model}\``);
  lines.push(`- Judge model: \`${meta.judgeModel}\``);
  lines.push(
    `- Embedder: \`${meta.embeddingProvider}\` / \`${meta.embeddingModel}\``,
  );
  lines.push(
    `- Repetitions per case: ${meta.repetitions} · Pass threshold: ${fmt.threshold(meta.passThreshold)}`,
  );
  lines.push(`- Started: ${fmt.timestamp(meta.startedAt)}`);
  if (meta.finishedAt) {
    lines.push(`- Finished: ${fmt.timestamp(meta.finishedAt)}`);
  }
  const grand =
    report.totalCost + report.totalJudgeCost + report.totalEmbeddingCost;
  lines.push(
    `- Result: **${report.passed}/${report.totalCases} cases passed** · total cost: ${fmt.cost(grand)} (agent ${fmt.cost(report.totalCost)} · judge ${fmt.cost(report.totalJudgeCost)} · embed ${fmt.cost(report.totalEmbeddingCost)}) · duration: ${fmt.durationMs(report.totalDurationMs)}`,
  );
  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push(
    "| Case | Pass rate | Cost (agent / judge / embed) | Avg latency | Tokens (in/out) |",
  );
  lines.push("|---|---|---|---|---|");
  for (const r of report.results) {
    const avgLatency =
      r.trials.length === 0
        ? 0
        : r.trials.reduce((s, t) => s + t.durationMs, 0) / r.trials.length;
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(
      `| ${status} ${r.name} | ${r.passes}/${r.trialCount} (${fmt.pct(r.passRate)}) | ${fmt.cost(r.totalCost)} / ${fmt.cost(r.totalJudgeCost)} / ${fmt.cost(r.totalEmbeddingCost)} | ${fmt.durationMs(avgLatency)} | ${fmt.tokens(r.totalInputTokens, r.totalOutputTokens)} |`,
    );
  }
  lines.push("");
  lines.push("## Per-assertion pass rates");
  lines.push("");
  for (const r of report.results) {
    lines.push(`### ${r.name}`);
    lines.push("");
    for (const [name, rate] of Object.entries(r.assertionPassRates)) {
      const score = r.assertionMeanScores[name];
      const scorePart =
        typeof score === "number" ? ` · mean score ${fmt.score(score)}` : "";
      lines.push(`- ${name}: ${fmt.pct(rate)}${scorePart}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function rebuildIndex(parentDir: string): Promise<void> {
  if (!existsSync(parentDir)) return;
  const entries = await readdir(parentDir, { withFileTypes: true });
  const runs: RunIndexEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
    const runDir = join(parentDir, entry.name);
    const summaryPath = join(runDir, "summary.json");
    if (!existsSync(summaryPath)) continue;
    let raw: string;
    try {
      raw = await readFile(summaryPath, "utf8");
    } catch (error) {
      logger.warn("could not read summary.json, skipping run", {
        path: summaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      logger.warn("summary.json has malformed JSON, skipping run", {
        path: summaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const parsed = RunReportSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("summary.json failed schema validation, skipping run", {
        path: summaryPath,
        issues: parsed.error.issues,
      });
      continue;
    }
    const report = parsed.data;
    const totalCost =
      report.totalCost + report.totalJudgeCost + report.totalEmbeddingCost;
    runs.push({
      runId: report.metadata.runId,
      startedAt: report.metadata.startedAt,
      finishedAt: report.metadata.finishedAt,
      model: report.metadata.model,
      judgeModel: report.metadata.judgeModel,
      embeddingProvider: report.metadata.embeddingProvider,
      passed: report.passed,
      total: report.totalCases,
      totalCost,
      durationMs: report.totalDurationMs,
      reportPath: relative(parentDir, join(runDir, "report.html")),
    });
  }

  await writeFile(join(parentDir, "index.html"), renderIndexHtml(runs), "utf8");
}
