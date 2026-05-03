import type { EmbeddingProvider } from "./config.js";
import { EmbedderError } from "./errors.js";

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export interface Embedder {
  provider: EmbeddingProvider;
  model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbedderError("cosineSimilarity vector length mismatch", {
      lhs: a.length,
      rhs: b.length,
    });
  }
  if (a.length === 0) {
    throw new EmbedderError("cosineSimilarity received empty vectors");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) {
      throw new EmbedderError(
        "cosineSimilarity received non-finite component",
        {
          index: i,
          a: av,
          b: bv,
        },
      );
    }
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  const raw = dot / denom;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-1, Math.min(1, raw));
}

export function validateVectors(
  expectedCount: number,
  vectors: unknown,
  context: { provider: EmbeddingProvider; model: string },
): number[][] {
  if (!Array.isArray(vectors)) {
    throw new EmbedderError("embedder did not return an array of vectors", {
      ...context,
      received: typeof vectors,
    });
  }
  if (vectors.length !== expectedCount) {
    throw new EmbedderError("embedder returned wrong number of vectors", {
      ...context,
      expected: expectedCount,
      actual: vectors.length,
    });
  }
  let dim: number | null = null;
  const out: number[][] = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v)) {
      throw new EmbedderError("embedder returned a non-array vector", {
        ...context,
        index: i,
      });
    }
    if (v.length === 0) {
      throw new EmbedderError("embedder returned an empty vector", {
        ...context,
        index: i,
      });
    }
    if (dim === null) dim = v.length;
    if (v.length !== dim) {
      throw new EmbedderError(
        "embedder returned vectors with mismatched dims",
        {
          ...context,
          index: i,
          expectedDim: dim,
          actualDim: v.length,
        },
      );
    }
    const row: number[] = [];
    for (let j = 0; j < v.length; j++) {
      const x = v[j];
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new EmbedderError("embedder returned non-finite component", {
          ...context,
          row: i,
          col: j,
          value: x,
        });
      }
      row.push(x);
    }
    out.push(row);
  }
  return out;
}

class OpenAIEmbedder implements Embedder {
  readonly provider: EmbeddingProvider = "openai";
  readonly model: string;
  private clientPromise: Promise<{
    embeddings: {
      create(opts: { model: string; input: string[] }): Promise<{
        data: { embedding: number[] }[];
        usage: { total_tokens: number };
      }>;
    };
  }> | null = null;

  constructor(model: string) {
    this.model = model;
  }

  private getClient() {
    if (!this.clientPromise) {
      if (!process.env.OPENAI_API_KEY) {
        throw new EmbedderError(
          "OPENAI_API_KEY is required for the OpenAI embedding provider. Set it or switch to EVAL_EMBEDDING_PROVIDER=local.",
          { provider: this.provider, model: this.model },
        );
      }
      this.clientPromise = import("openai").then(
        (mod) => new mod.default() as never,
      );
    }
    return this.clientPromise;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const client = await this.getClient();
    const response = await client.embeddings.create({
      model: this.model,
      input: texts,
    });
    const rawVectors = response.data.map((d) => d.embedding);
    const vectors = validateVectors(texts.length, rawVectors, {
      provider: this.provider,
      model: this.model,
    });
    const totalTokens = response.usage.total_tokens;
    const tokens =
      Number.isFinite(totalTokens) && totalTokens >= 0 ? totalTokens : 0;
    return { vectors, tokens };
  }
}

const LOCAL_DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

interface LocalExtractor {
  (
    texts: string | string[],
    opts: { pooling: "mean"; normalize: boolean },
  ): Promise<{ tolist(): unknown }>;
}

class LocalEmbedder implements Embedder {
  readonly provider: EmbeddingProvider = "local";
  readonly model: string;
  private extractorPromise: Promise<LocalExtractor> | null = null;
  private warmedUp = false;

  constructor(model: string) {
    this.model = model === "local" ? LOCAL_DEFAULT_MODEL_ID : model;
  }

  private getExtractor(): Promise<LocalExtractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const mod = await import("@xenova/transformers");
        if (mod.env) {
          mod.env.allowLocalModels = true;
        }
        return mod.pipeline("feature-extraction", this.model) as never;
      })();
    }
    return this.extractorPromise;
  }

  private async warmup(): Promise<void> {
    if (this.warmedUp) return;
    const probe = await this.embedRaw(["warmup"]);
    if (probe.vectors.length !== 1 || probe.vectors[0].length === 0) {
      throw new EmbedderError("LocalEmbedder warmup failed: bad vector shape", {
        provider: this.provider,
        model: this.model,
        observedShape: [probe.vectors.length, probe.vectors[0]?.length ?? 0],
      });
    }
    const sim = cosineSimilarity(probe.vectors[0], probe.vectors[0]);
    if (sim < 0.99) {
      throw new EmbedderError(
        "LocalEmbedder warmup failed: self-similarity below 0.99",
        { provider: this.provider, model: this.model, sim },
      );
    }
    this.warmedUp = true;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    await this.warmup();
    return this.embedRaw(texts);
  }

  private async embedRaw(texts: string[]): Promise<EmbedResult> {
    const extractor = await this.getExtractor();
    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });
    const list = output.tolist();
    const rawVectors = normalizeTolistShape(list, texts.length, {
      provider: this.provider,
      model: this.model,
    });
    const vectors = validateVectors(texts.length, rawVectors, {
      provider: this.provider,
      model: this.model,
    });
    const tokens = approximateTokenCount(texts);
    return { vectors, tokens };
  }
}

export function normalizeTolistShape(
  list: unknown,
  expectedCount: number,
  context: { provider: EmbeddingProvider; model: string },
): number[][] {
  if (!Array.isArray(list)) {
    throw new EmbedderError("LocalEmbedder tolist() did not return an array", {
      ...context,
      received: typeof list,
    });
  }
  if (list.length === 0) {
    throw new EmbedderError("LocalEmbedder tolist() returned empty result", {
      ...context,
    });
  }
  const first = list[0];
  if (Array.isArray(first) && typeof first[0] === "number") {
    return list as number[][];
  }
  if (Array.isArray(first) && Array.isArray(first[0])) {
    if (
      list.length === 1 &&
      Array.isArray(first) &&
      first.length === expectedCount
    ) {
      return first as number[][];
    }
    throw new EmbedderError(
      "LocalEmbedder tolist() returned an unexpected 3D shape",
      { ...context, shape: describeShape(list) },
    );
  }
  if (typeof first === "number") {
    if (expectedCount !== 1) {
      throw new EmbedderError(
        "LocalEmbedder tolist() returned a 1D vector but multiple inputs were provided",
        { ...context, expectedCount },
      );
    }
    return [list as number[]];
  }
  throw new EmbedderError(
    "LocalEmbedder tolist() returned an unsupported shape",
    {
      ...context,
      shape: describeShape(list),
    },
  );
}

function describeShape(value: unknown, depth = 0): string {
  if (depth > 3) return "...";
  if (Array.isArray(value)) {
    return `Array[${value.length}](${describeShape(value[0], depth + 1)})`;
  }
  return typeof value;
}

function approximateTokenCount(texts: string[]): number {
  let total = 0;
  for (const t of texts) total += Math.max(1, Math.ceil(t.length / 4));
  return total;
}

let cachedEmbedder: { embedder: Embedder; key: string } | null = null;

export function getEmbedder(opts: {
  provider: EmbeddingProvider;
  model: string;
}): Embedder {
  const key = `${opts.provider}:${opts.model}`;
  if (cachedEmbedder && cachedEmbedder.key === key)
    return cachedEmbedder.embedder;
  const embedder: Embedder =
    opts.provider === "openai"
      ? new OpenAIEmbedder(opts.model)
      : new LocalEmbedder(opts.model);
  cachedEmbedder = { embedder, key };
  return embedder;
}

export function resetEmbedderCacheForTesting(): void {
  cachedEmbedder = null;
}
