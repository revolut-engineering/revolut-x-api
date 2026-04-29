export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheWritePer1M?: number;
  cacheReadPer1M?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": {
    inputPer1M: 15,
    outputPer1M: 75,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.5,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  "claude-haiku-4-5": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheWritePer1M: 1.25,
    cacheReadPer1M: 0.1,
  },
};

export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

function safeNonNegFinite(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : 0;
}

export function estimateCostUsd(model: string, usage: UsageInput): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const inTok = safeNonNegFinite(usage.inputTokens);
  const outTok = safeNonNegFinite(usage.outputTokens);
  const cacheWriteTok = safeNonNegFinite(usage.cacheCreationInputTokens);
  const cacheReadTok = safeNonNegFinite(usage.cacheReadInputTokens);
  let cost = 0;
  cost += (inTok / 1_000_000) * pricing.inputPer1M;
  cost += (outTok / 1_000_000) * pricing.outputPer1M;
  if (pricing.cacheWritePer1M) {
    cost += (cacheWriteTok / 1_000_000) * pricing.cacheWritePer1M;
  }
  if (pricing.cacheReadPer1M) {
    cost += (cacheReadTok / 1_000_000) * pricing.cacheReadPer1M;
  }
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

export const EMBEDDING_PRICING: Record<string, { per1M: number }> = {
  "text-embedding-3-small": { per1M: 0.02 },
  "text-embedding-3-large": { per1M: 0.13 },
  local: { per1M: 0 },
};

export function estimateEmbeddingCostUsd(
  model: string,
  tokens: number,
): number {
  const pricing = EMBEDDING_PRICING[model];
  if (!pricing) return 0;
  const tok = safeNonNegFinite(tokens);
  const cost = (tok / 1_000_000) * pricing.per1M;
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}
