import type {
  AssertionContext,
  AssertionOutcome,
  SemanticAssertion,
} from "./types.js";
import { cosineSimilarity, type Embedder } from "./embeddings.js";
import { estimateEmbeddingCostUsd } from "./pricing.js";
import { passesThreshold } from "./judge.js";
import { SemanticAssertionError, serializeError } from "./errors.js";

export const DEFAULT_SEMANTIC_THRESHOLD = 0.7;

export interface SemanticRunResult {
  outcome: AssertionOutcome;
  cost: number;
}

export async function runSemantic(
  assertion: SemanticAssertion,
  ctx: AssertionContext,
  embedder: Embedder,
): Promise<SemanticRunResult> {
  const threshold = assertion.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const references = collectReferences(assertion);
  if (references.length === 0) {
    throw new SemanticAssertionError(
      "semantic assertion reached runSemantic with no references — schema invariant violated",
      { assertionName: assertion.name },
    );
  }

  if (ctx.finalText.length === 0) {
    return {
      cost: 0,
      outcome: {
        name: assertion.name,
        kind: "semantic",
        passed: false,
        score: 0,
        error: "Agent produced no final text to compare.",
      },
    };
  }

  try {
    const { vectors, tokens } = await embedder.embed([
      ctx.finalText,
      ...references,
    ]);
    const cost = estimateEmbeddingCostUsd(embedder.model, tokens);

    if (vectors.length !== references.length + 1) {
      throw new SemanticAssertionError(
        "embedder returned wrong number of vectors",
        {
          expected: references.length + 1,
          actual: vectors.length,
        },
      );
    }

    const finalVec = vectors[0];
    const refVecs = vectors.slice(1);
    const sims = refVecs.map((v) => cosineSimilarity(finalVec, v));
    const finiteSims = sims.filter((s) => Number.isFinite(s));
    if (finiteSims.length === 0) {
      return {
        cost,
        outcome: {
          name: assertion.name,
          kind: "semantic",
          passed: false,
          score: 0,
          error: "All cosine similarities were non-finite.",
        },
      };
    }

    const rawScore =
      assertion.mode === "avg"
        ? finiteSims.reduce((a, b) => a + b, 0) / finiteSims.length
        : Math.max(...finiteSims);

    const score = clampUnit(rawScore);

    return {
      cost,
      outcome: {
        name: assertion.name,
        kind: "semantic",
        passed: passesThreshold(score, threshold),
        score,
        reasoning: formatReasoning(assertion, sims, threshold),
      },
    };
  } catch (error) {
    return {
      cost: 0,
      outcome: {
        name: assertion.name,
        kind: "semantic",
        passed: false,
        score: 0,
        error: JSON.stringify(serializeError(error)),
      },
    };
  }
}

function collectReferences(assertion: SemanticAssertion): string[] {
  if (assertion.references && assertion.references.length > 0) {
    return assertion.references;
  }
  if (assertion.reference) return [assertion.reference];
  return [];
}

function formatReasoning(
  assertion: SemanticAssertion,
  sims: number[],
  threshold: number,
): string {
  const mode = assertion.mode === "avg" ? "avg" : "max";
  const formatted = sims
    .map((s) => (Number.isFinite(s) ? s.toFixed(3) : "n/a"))
    .join(", ");
  return `${mode} cosine sim across ${sims.length} ref(s) [${formatted}] vs threshold ${threshold.toFixed(3)}`;
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
