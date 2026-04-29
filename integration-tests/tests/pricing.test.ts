import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  estimateEmbeddingCostUsd,
} from "../src/eval-framework/pricing.js";

describe("estimateCostUsd", () => {
  it("computes cost for a known model", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(15, 5);
  });

  it("adds output cost", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(75, 5);
  });

  it("includes cache write tokens when defined", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18.75, 5);
  });

  it("includes cache read tokens when defined", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.5, 5);
  });

  it("returns 0 for unknown models", () => {
    expect(
      estimateCostUsd("unknown-model", { inputTokens: 999, outputTokens: 999 }),
    ).toBe(0);
  });

  it("treats non-finite tokens as 0", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
    });
    expect(cost).toBe(0);
  });

  it("treats negative tokens as 0", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      inputTokens: -10,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });
});

describe("estimateEmbeddingCostUsd", () => {
  it("computes cost for OpenAI small", () => {
    expect(
      estimateEmbeddingCostUsd("text-embedding-3-small", 1_000_000),
    ).toBeCloseTo(0.02, 5);
  });

  it("returns 0 for local provider model id", () => {
    expect(estimateEmbeddingCostUsd("local", 1_000_000)).toBe(0);
  });

  it("returns 0 for unknown model", () => {
    expect(estimateEmbeddingCostUsd("???", 1_000_000)).toBe(0);
  });

  it("treats non-finite tokens as 0", () => {
    expect(estimateEmbeddingCostUsd("text-embedding-3-small", Number.NaN)).toBe(
      0,
    );
  });
});
