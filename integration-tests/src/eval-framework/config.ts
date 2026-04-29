import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { EvalConfigError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));

export type EmbeddingProvider = "openai" | "local";

export interface EvalConfig {
  repetitions: number;
  passThreshold: number;
  runId: string;
  reportDir: string;
  model: string;
  costCapUsd: number;
  judgeModel: string;
  judgeMaxTokens: number;
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  strict: boolean;
}

const PositiveInt = z
  .number()
  .int()
  .refine((n) => Number.isFinite(n) && n > 0, "must be a positive integer");
const FiniteNonNeg = z
  .number()
  .refine(
    (n) => Number.isFinite(n) && n >= 0,
    "must be finite and non-negative",
  );
const Probability = z
  .number()
  .refine((n) => Number.isFinite(n) && n >= 0 && n <= 1, "must be in [0, 1]");
const NonEmptyString = z.string().min(1);
const ProviderSchema = z.enum(["openai", "local"]);

const ConfigSchema = z.object({
  repetitions: PositiveInt,
  passThreshold: Probability,
  runId: NonEmptyString,
  reportDir: NonEmptyString,
  model: NonEmptyString,
  costCapUsd: FiniteNonNeg,
  judgeModel: NonEmptyString,
  judgeMaxTokens: PositiveInt,
  embeddingProvider: ProviderSchema,
  embeddingModel: NonEmptyString,
  strict: z.boolean(),
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

function envEmbeddingProvider(): EmbeddingProvider {
  const raw = (process.env.EVAL_EMBEDDING_PROVIDER ?? "").toLowerCase();
  return raw === "openai" ? "openai" : "local";
}

function envBool(name: string): boolean {
  const raw = (process.env[name] ?? "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function defaultEmbeddingModel(provider: EmbeddingProvider): string {
  return provider === "openai" ? "text-embedding-3-small" : "local";
}

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

let cached: EvalConfig | null = null;

export function getEvalConfig(): EvalConfig {
  if (cached) return cached;
  const runId = envStr("EVAL_RUN_ID", defaultRunId());
  const reportDir = envStr(
    "EVAL_REPORT_DIR",
    resolve(here, "..", "..", "reports", `run-${runId}`),
  );
  const embeddingProvider = envEmbeddingProvider();
  const candidate = {
    repetitions: envInt("EVAL_REPETITIONS", 3),
    passThreshold: envFloat("EVAL_PASS_THRESHOLD", 2 / 3),
    runId,
    reportDir,
    model: envStr("EVAL_MODEL", "claude-opus-4-7"),
    costCapUsd: envFloat("EVAL_COST_CAP_USD", 5),
    judgeModel: envStr("EVAL_JUDGE_MODEL", "claude-sonnet-4-6"),
    judgeMaxTokens: envInt("EVAL_JUDGE_MAX_TOKENS", 512),
    embeddingProvider,
    embeddingModel: envStr(
      "EVAL_EMBEDDING_MODEL",
      defaultEmbeddingModel(embeddingProvider),
    ),
    strict: envBool("EVAL_STRICT"),
  };
  const parsed = ConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new EvalConfigError("invalid eval configuration from environment", {
      issues: parsed.error.issues,
      candidate,
    });
  }
  if (
    parsed.data.embeddingProvider === "openai" &&
    !process.env.OPENAI_API_KEY
  ) {
    throw new EvalConfigError(
      "EVAL_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY. Set it, or switch to EVAL_EMBEDDING_PROVIDER=local.",
      { embeddingProvider: parsed.data.embeddingProvider },
    );
  }
  cached = parsed.data;
  return cached;
}

export function resetEvalConfigForTesting(): void {
  cached = null;
}
