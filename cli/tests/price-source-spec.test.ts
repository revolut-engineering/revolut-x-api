import { describe, it, expect } from "vitest";
import { parseSpec, PriceSpecError } from "../src/shared/price-source/spec.js";

describe("parseSpec", () => {
  it("defaults empty/api to api kind", () => {
    expect(parseSpec(undefined)).toEqual({ kind: "api", raw: "api" });
    expect(parseSpec("")).toEqual({ kind: "api", raw: "api" });
    expect(parseSpec("api")).toEqual({ kind: "api", raw: "api" });
  });

  it("parses stdin and interactive", () => {
    expect(parseSpec("stdin").kind).toBe("stdin");
    expect(parseSpec("-").kind).toBe("stdin");
    expect(parseSpec("interactive").kind).toBe("interactive");
  });

  it("parses file: with absolute path", () => {
    const s = parseSpec("file:/tmp/x.csv");
    expect(s.kind).toBe("file");
    expect(s.path).toBe("/tmp/x.csv");
  });

  it("parses inline: as numeric list", () => {
    const s = parseSpec("inline:100,101.5,98");
    expect(s.kind).toBe("inline");
    expect(s.values).toEqual([100, 101.5, 98]);
  });

  it("rejects inline with non-positive values", () => {
    expect(() => parseSpec("inline:100,-5")).toThrow(PriceSpecError);
    expect(() => parseSpec("inline:0")).toThrow(PriceSpecError);
    expect(() => parseSpec("inline:abc")).toThrow(PriceSpecError);
  });

  it("parses gen:<type>?params", () => {
    const s = parseSpec("gen:sine?start=100&amp=10&steps=200");
    expect(s.kind).toBe("gen");
    expect(s.gen?.type).toBe("sine");
    expect(s.gen?.params).toEqual({ start: "100", amp: "10", steps: "200" });
  });

  it("decodes URL-encoded gen params", () => {
    const s = parseSpec("gen:steps?values=100%2C110%2C90&hold=5");
    expect(s.gen?.params.values).toBe("100,110,90");
    expect(s.gen?.params.hold).toBe("5");
  });

  it("rejects unknown generator types", () => {
    expect(() => parseSpec("gen:bogus")).toThrow(PriceSpecError);
  });

  it("rejects unrecognized spec form", () => {
    expect(() => parseSpec("garbage")).toThrow(PriceSpecError);
  });
});
