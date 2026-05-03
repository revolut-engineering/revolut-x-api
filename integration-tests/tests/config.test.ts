import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEvalConfig,
  resetEvalConfigForTesting,
} from "../src/eval-framework/config.js";
import { EvalConfigError } from "../src/eval-framework/errors.js";

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

const snapshot: Record<string, string | undefined> = {};

function captureEnv() {
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("getEvalConfig — defaults", () => {
  beforeEach(() => {
    captureEnv();
    clearEnv();
    resetEvalConfigForTesting();
  });
  afterEach(() => {
    restoreEnv();
    resetEvalConfigForTesting();
  });

  it("uses defaults when env is empty", () => {
    const cfg = getEvalConfig();
    expect(cfg.repetitions).toBe(3);
    expect(cfg.passThreshold).toBeCloseTo(2 / 3, 5);
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.judgeModel).toBe("claude-sonnet-4-6");
    expect(cfg.judgeMaxTokens).toBe(512);
    expect(cfg.costCapUsd).toBe(5);
    expect(cfg.embeddingProvider).toBe("local");
    expect(cfg.embeddingModel).toBe("local");
  });

  it("caches the same instance on repeated calls", () => {
    const first = getEvalConfig();
    const second = getEvalConfig();
    expect(first).toBe(second);
  });
});

describe("getEvalConfig — env overrides", () => {
  beforeEach(() => {
    captureEnv();
    clearEnv();
    resetEvalConfigForTesting();
  });
  afterEach(() => {
    restoreEnv();
    resetEvalConfigForTesting();
  });

  it("parses EVAL_REPETITIONS as a positive integer", () => {
    process.env.EVAL_REPETITIONS = "5";
    expect(getEvalConfig().repetitions).toBe(5);
  });

  it("falls back to default on garbage EVAL_REPETITIONS", () => {
    process.env.EVAL_REPETITIONS = "not-a-number";
    expect(getEvalConfig().repetitions).toBe(3);
  });

  it("parses EVAL_PASS_THRESHOLD as float in [0,1]", () => {
    process.env.EVAL_PASS_THRESHOLD = "0.8";
    expect(getEvalConfig().passThreshold).toBeCloseTo(0.8, 5);
  });

  it("rejects EVAL_PASS_THRESHOLD > 1", () => {
    process.env.EVAL_PASS_THRESHOLD = "1.5";
    expect(() => getEvalConfig()).toThrow(EvalConfigError);
  });

  it("rejects EVAL_REPETITIONS = 0", () => {
    process.env.EVAL_REPETITIONS = "0";
    expect(() => getEvalConfig()).toThrow(EvalConfigError);
  });

  it("uses EVAL_RUN_ID when provided", () => {
    process.env.EVAL_RUN_ID = "my-run";
    expect(getEvalConfig().runId).toBe("my-run");
  });

  it("respects EVAL_REPORT_DIR override", () => {
    process.env.EVAL_REPORT_DIR = "/tmp/custom-reports";
    expect(getEvalConfig().reportDir).toBe("/tmp/custom-reports");
  });

  it("normalizes invalid EVAL_EMBEDDING_PROVIDER to local", () => {
    process.env.EVAL_EMBEDDING_PROVIDER = "voyage";
    expect(getEvalConfig().embeddingProvider).toBe("local");
  });

  it("uses 'text-embedding-3-small' as default OpenAI model", () => {
    process.env.EVAL_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getEvalConfig().embeddingModel).toBe("text-embedding-3-small");
  });
});

describe("getEvalConfig — OPENAI_API_KEY validation", () => {
  beforeEach(() => {
    captureEnv();
    clearEnv();
    resetEvalConfigForTesting();
  });
  afterEach(() => {
    restoreEnv();
    resetEvalConfigForTesting();
  });

  it("throws when provider=openai but OPENAI_API_KEY is missing", () => {
    process.env.EVAL_EMBEDDING_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    expect(() => getEvalConfig()).toThrow(EvalConfigError);
    expect(() => getEvalConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it("does not throw when provider=openai and OPENAI_API_KEY is set", () => {
    process.env.EVAL_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(() => getEvalConfig()).not.toThrow();
  });

  it("does not require OPENAI_API_KEY when provider=local", () => {
    process.env.EVAL_EMBEDDING_PROVIDER = "local";
    delete process.env.OPENAI_API_KEY;
    expect(() => getEvalConfig()).not.toThrow();
  });
});

describe("getEvalConfig — EVAL_STRICT", () => {
  beforeEach(() => {
    captureEnv();
    clearEnv();
    resetEvalConfigForTesting();
  });
  afterEach(() => {
    restoreEnv();
    resetEvalConfigForTesting();
  });

  it("defaults to lenient (strict=false) when EVAL_STRICT is unset", () => {
    expect(getEvalConfig().strict).toBe(false);
  });

  it("recognizes EVAL_STRICT=1 as strict", () => {
    process.env.EVAL_STRICT = "1";
    expect(getEvalConfig().strict).toBe(true);
  });

  it("recognizes EVAL_STRICT=true as strict", () => {
    process.env.EVAL_STRICT = "true";
    expect(getEvalConfig().strict).toBe(true);
  });

  it("treats EVAL_STRICT=0 as lenient", () => {
    process.env.EVAL_STRICT = "0";
    expect(getEvalConfig().strict).toBe(false);
  });

  it("treats EVAL_STRICT=false as lenient", () => {
    process.env.EVAL_STRICT = "false";
    expect(getEvalConfig().strict).toBe(false);
  });
});
