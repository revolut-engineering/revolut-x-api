import { initRunReport, finalizeRunReport } from "./reporter.js";
import { getEvalConfig, resetEvalConfigForTesting } from "./config.js";
import { logger } from "./logger.js";
import { fmt } from "./format.js";

export async function setup(): Promise<void> {
  const config = getEvalConfig();
  process.env.EVAL_RUN_ID = config.runId;
  process.env.EVAL_REPORT_DIR = config.reportDir;
  process.env.EVAL_REPETITIONS = String(config.repetitions);
  process.env.EVAL_PASS_THRESHOLD = String(config.passThreshold);
  process.env.EVAL_MODEL = config.model;
  process.env.EVAL_COST_CAP_USD = String(config.costCapUsd);
  process.env.EVAL_JUDGE_MODEL = config.judgeModel;
  process.env.EVAL_JUDGE_MAX_TOKENS = String(config.judgeMaxTokens);
  process.env.EVAL_EMBEDDING_PROVIDER = config.embeddingProvider;
  process.env.EVAL_EMBEDDING_MODEL = config.embeddingModel;

  await initRunReport();

  logger.info(
    `run ${config.runId} · model ${config.model} · judge ${config.judgeModel} · embed ${config.embeddingProvider}/${config.embeddingModel} · ${config.repetitions} trial(s)/case · threshold ${fmt.threshold(config.passThreshold)}`,
  );
  logger.info(`reports → ${config.reportDir}`);
}

export async function teardown(): Promise<void> {
  resetEvalConfigForTesting();
  const report = await finalizeRunReport();
  if (!report) return;
  const grand =
    report.totalCost + report.totalJudgeCost + report.totalEmbeddingCost;
  logger.info(
    `${report.passed}/${report.totalCases} cases passed · total cost: ${fmt.cost(grand)} (agent ${fmt.cost(report.totalCost)} · judge ${fmt.cost(report.totalJudgeCost)} · embed ${fmt.cost(report.totalEmbeddingCost)}) · duration: ${fmt.durationMs(report.totalDurationMs)}`,
  );
  logger.info(
    `summary: ${report.metadata.runId} → summary.json, junit.xml, report.md, report.html, ../index.html`,
  );
}
