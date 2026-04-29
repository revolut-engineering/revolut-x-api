import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  normalizeTolistShape,
  validateVectors,
} from "../src/eval-framework/embeddings.js";
import { EmbedderError } from "../src/eval-framework/errors.js";

const ctxLocal = { provider: "local" as const, model: "test" };

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns -1 for antiparallel vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it("clamps drifting >1 results to 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeLessThanOrEqual(1);
  });

  it("returns 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(EmbedderError);
  });

  it("throws on empty vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(EmbedderError);
  });

  it("throws on non-finite components", () => {
    expect(() => cosineSimilarity([Number.NaN, 0], [1, 0])).toThrow(
      EmbedderError,
    );
    expect(() =>
      cosineSimilarity([1, 0], [Number.POSITIVE_INFINITY, 0]),
    ).toThrow(EmbedderError);
  });
});

describe("validateVectors", () => {
  const ctx = { provider: "local" as const, model: "test" };

  it("accepts a well-formed batch", () => {
    const out = validateVectors(
      2,
      [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      ctx,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("rejects when count mismatches", () => {
    expect(() => validateVectors(2, [[0.1]], ctx)).toThrow(EmbedderError);
  });

  it("rejects when input is not an array", () => {
    expect(() => validateVectors(1, "not array", ctx)).toThrow(EmbedderError);
    expect(() => validateVectors(1, null, ctx)).toThrow(EmbedderError);
  });

  it("rejects empty inner vectors", () => {
    expect(() => validateVectors(1, [[]], ctx)).toThrow(EmbedderError);
  });

  it("rejects mismatched inner dims", () => {
    expect(() =>
      validateVectors(
        2,
        [
          [0.1, 0.2],
          [0.3, 0.4, 0.5],
        ],
        ctx,
      ),
    ).toThrow(EmbedderError);
  });

  it("rejects non-finite components", () => {
    expect(() => validateVectors(1, [[0.1, Number.NaN]], ctx)).toThrow(
      EmbedderError,
    );
    expect(() => validateVectors(1, [[Number.POSITIVE_INFINITY]], ctx)).toThrow(
      EmbedderError,
    );
  });

  it("rejects non-array elements", () => {
    expect(() => validateVectors(1, [42], ctx)).toThrow(EmbedderError);
  });
});

describe("normalizeTolistShape", () => {
  it("passes through a 2D number[][] result", () => {
    const out = normalizeTolistShape(
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      2,
      ctxLocal,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.1, 0.2]);
  });

  it("wraps a 1D number[] result for a single input", () => {
    const out = normalizeTolistShape([0.1, 0.2, 0.3], 1, ctxLocal);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("rejects 1D shape when multiple inputs were provided", () => {
    expect(() => normalizeTolistShape([0.1, 0.2], 2, ctxLocal)).toThrow(
      EmbedderError,
    );
  });

  it("rejects an empty list", () => {
    expect(() => normalizeTolistShape([], 1, ctxLocal)).toThrow(EmbedderError);
  });

  it("rejects a non-array result", () => {
    expect(() => normalizeTolistShape("not array", 1, ctxLocal)).toThrow(
      EmbedderError,
    );
  });

  it("rejects unsupported 3D shapes", () => {
    expect(() =>
      normalizeTolistShape(
        [
          [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
          [
            [0.5, 0.6],
            [0.7, 0.8],
          ],
        ],
        2,
        ctxLocal,
      ),
    ).toThrow(EmbedderError);
  });
});
