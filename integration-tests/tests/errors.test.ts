import { describe, it, expect } from "vitest";
import {
  EmbedderError,
  EvalConfigError,
  EvalFrameworkError,
  JudgeParseError,
  ReportCorruptError,
  SemanticAssertionError,
  serializeError,
} from "../src/eval-framework/errors.js";

describe("EvalFrameworkError subclasses", () => {
  it("each subclass identifies via instanceof", () => {
    expect(new EvalConfigError("x")).toBeInstanceOf(EvalFrameworkError);
    expect(new EmbedderError("x")).toBeInstanceOf(EvalFrameworkError);
    expect(new JudgeParseError("x")).toBeInstanceOf(EvalFrameworkError);
    expect(new SemanticAssertionError("x")).toBeInstanceOf(EvalFrameworkError);
    expect(new ReportCorruptError("x")).toBeInstanceOf(EvalFrameworkError);
  });

  it("retains structured details", () => {
    const err = new EmbedderError("vector mismatch", {
      provider: "local",
      expected: 2,
      actual: 1,
    });
    expect(err.details.expected).toBe(2);
    expect(err.details.provider).toBe("local");
  });

  it("toJSON returns the serialized shape", () => {
    const err = new EvalConfigError("bad config", { field: "threshold" });
    const json = err.toJSON();
    expect(json.name).toBe("EvalConfigError");
    expect(json.message).toBe("bad config");
    expect(json.details).toEqual({ field: "threshold" });
  });
});

describe("serializeError", () => {
  it("serializes a plain Error with message and name", () => {
    const out = serializeError(new TypeError("nope"));
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("nope");
  });

  it("preserves nested causes", () => {
    const inner = new EvalConfigError("inner");
    const outer = new EmbedderError("outer", { x: 1 }, inner);
    const out = serializeError(outer);
    expect(out.name).toBe("EmbedderError");
    expect(out.cause?.name).toBe("EvalConfigError");
  });

  it("falls back to String() for non-Error values", () => {
    expect(serializeError("string error")).toEqual({
      name: "Unknown",
      message: "string error",
    });
    expect(serializeError(42).message).toBe("42");
  });
});
