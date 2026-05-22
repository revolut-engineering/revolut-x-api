import { describe, it, expect } from "vitest";
import { generatePrices } from "../src/shared/price-source/sources/generators.js";

describe("generatePrices", () => {
  it("linear ramp produces N points from start to end", () => {
    const v = generatePrices("linear", {
      start: "100",
      end: "110",
      steps: "11",
    });
    expect(v).toHaveLength(11);
    expect(v[0]).toBe(100);
    expect(v[v.length - 1]).toBe(110);
    expect(v[5]).toBeCloseTo(105, 6);
  });

  it("sine oscillates around start", () => {
    const v = generatePrices("sine", {
      start: "100",
      amp: "5",
      period: "4",
      steps: "8",
    });
    expect(v).toHaveLength(8);
    expect(v[0]).toBeCloseTo(100, 6);
    expect(v[1]).toBeCloseTo(105, 6);
    expect(v[2]).toBeCloseTo(100, 6);
    expect(v[3]).toBeCloseTo(95, 6);
  });

  it("walk is deterministic given a seed", () => {
    const a = generatePrices("walk", {
      start: "100",
      sigma: "0.5",
      seed: "42",
      steps: "50",
    });
    const b = generatePrices("walk", {
      start: "100",
      sigma: "0.5",
      seed: "42",
      steps: "50",
    });
    expect(a).toEqual(b);
    expect(a).toHaveLength(50);
    expect(a[0]).toBe(100);
  });

  it("walk differs across seeds", () => {
    const a = generatePrices("walk", {
      start: "100",
      sigma: "0.5",
      seed: "1",
      steps: "20",
    });
    const b = generatePrices("walk", {
      start: "100",
      sigma: "0.5",
      seed: "2",
      steps: "20",
    });
    expect(a).not.toEqual(b);
  });

  it("steps holds each value for hold ticks", () => {
    const v = generatePrices("steps", { values: "100,110,90", hold: "3" });
    expect(v).toEqual([100, 100, 100, 110, 110, 110, 90, 90, 90]);
  });
});
