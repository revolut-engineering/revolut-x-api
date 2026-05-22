import { describe, it, expect } from "vitest";
import { parseContent } from "../src/shared/price-source/format/parse.js";

describe("parseContent", () => {
  it("parses price-only CSV (one value per line)", () => {
    const c = parseContent("100\n102\n98\n", "x");
    expect(c).toHaveLength(3);
    expect(c[0].open.toString()).toBe("100");
    expect(c[0].high.toString()).toBe("100");
    expect(c[0].low.toString()).toBe("100");
    expect(c[0].close.toString()).toBe("100");
    expect(c[2].close.toString()).toBe("98");
  });

  it("parses 4-column OHLC CSV", () => {
    const c = parseContent("100,102,98,101\n101,103,99,100\n", "x");
    expect(c).toHaveLength(2);
    expect(c[0].open.toString()).toBe("100");
    expect(c[0].high.toString()).toBe("102");
    expect(c[0].low.toString()).toBe("98");
    expect(c[0].close.toString()).toBe("101");
  });

  it("detects a header row with named columns", () => {
    const csv = "timestamp,open,high,low,close\n1700000000,100,102,98,101\n";
    const c = parseContent(csv, "x");
    expect(c).toHaveLength(1);
    expect(c[0].start).toBe(1700000000);
    expect(c[0].close.toString()).toBe("101");
  });

  it("parses 5-col timestamp+OHLC", () => {
    const c = parseContent("1700000000,100,102,98,101\n", "x");
    expect(c).toHaveLength(1);
    expect(c[0].start).toBe(1700000000);
  });

  it("parses JSON array of numbers", () => {
    const c = parseContent("[100, 101.5, 98]", "x");
    expect(c).toHaveLength(3);
    expect(c[1].close.toString()).toBe("101.5");
  });

  it("parses JSON array of OHLC objects", () => {
    const c = parseContent(
      JSON.stringify([
        { open: 100, high: 102, low: 98, close: 101 },
        { open: 101, high: 103, low: 99, close: 100 },
      ]),
      "x",
    );
    expect(c).toHaveLength(2);
    expect(c[0].open.toString()).toBe("100");
    expect(c[1].close.toString()).toBe("100");
  });

  it("parses NDJSON of {price} lines", () => {
    const c = parseContent('{"price":100}\n{"price":101.5}\n', "x");
    expect(c).toHaveLength(2);
    expect(c[0].close.toString()).toBe("100");
    expect(c[1].close.toString()).toBe("101.5");
  });

  it("throws on empty input", () => {
    expect(() => parseContent("", "x")).toThrow();
    expect(() => parseContent("   ", "x")).toThrow();
  });
});
