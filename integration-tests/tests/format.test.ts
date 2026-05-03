import { describe, it, expect } from "vitest";
import { fmt } from "../src/eval-framework/format.js";

describe("fmt.score", () => {
  it("formats finite values to 3 decimals", () => {
    expect(fmt.score(0)).toBe("0.000");
    expect(fmt.score(0.5)).toBe("0.500");
    expect(fmt.score(0.6995)).toBe("0.700");
    expect(fmt.score(0.69949)).toBe("0.699");
    expect(fmt.score(1)).toBe("1.000");
  });
  it("returns n/a for non-finite", () => {
    expect(fmt.score(Number.NaN)).toBe("n/a");
    expect(fmt.score(Number.POSITIVE_INFINITY)).toBe("n/a");
    expect(fmt.score(Number.NEGATIVE_INFINITY)).toBe("n/a");
  });
});

describe("fmt.pct", () => {
  it("formats finite values as percent", () => {
    expect(fmt.pct(0)).toBe("0%");
    expect(fmt.pct(0.5)).toBe("50%");
    expect(fmt.pct(1)).toBe("100%");
    expect(fmt.pct(0.667, 1)).toBe("66.7%");
  });
  it("returns n/a for non-finite", () => {
    expect(fmt.pct(Number.NaN)).toBe("n/a");
  });
});

describe("fmt.cost", () => {
  it("formats with $ prefix and 4 decimals", () => {
    expect(fmt.cost(0)).toBe("$0.0000");
    expect(fmt.cost(1.234567)).toBe("$1.2346");
    expect(fmt.cost(0.0001)).toBe("$0.0001");
  });
  it("returns $0.0000 for non-finite", () => {
    expect(fmt.cost(Number.NaN)).toBe("$0.0000");
    expect(fmt.cost(Number.POSITIVE_INFINITY)).toBe("$0.0000");
  });
});

describe("fmt.durationMs", () => {
  it("formats milliseconds as seconds with 1 decimal", () => {
    expect(fmt.durationMs(0)).toBe("0.0s");
    expect(fmt.durationMs(1500)).toBe("1.5s");
    expect(fmt.durationMs(60_000)).toBe("60.0s");
  });
  it("returns 0.0s for non-finite", () => {
    expect(fmt.durationMs(Number.NaN)).toBe("0.0s");
  });
});

describe("fmt.threshold", () => {
  it("aliases pct", () => {
    expect(fmt.threshold(0.667)).toBe(fmt.pct(0.667));
  });
});

describe("fmt.tokens", () => {
  it("formats input/output", () => {
    expect(fmt.tokens(100, 50)).toBe("100/50");
  });
  it("coerces non-finite to 0", () => {
    expect(fmt.tokens(Number.NaN, 5)).toBe("0/5");
    expect(fmt.tokens(10, Number.POSITIVE_INFINITY)).toBe("10/0");
  });
});

describe("fmt.timestamp", () => {
  it("formats ISO strings as 'YYYY-MM-DD HH:MM:SS UTC'", () => {
    expect(fmt.timestamp("2026-04-28T13:01:30.000Z")).toBe(
      "2026-04-28 13:01:30 UTC",
    );
  });
  it("returns em-dash for undefined / empty", () => {
    expect(fmt.timestamp(undefined)).toBe("—");
    expect(fmt.timestamp("")).toBe("—");
  });
  it("returns the raw string when not parseable", () => {
    expect(fmt.timestamp("not a date")).toBe("not a date");
  });
});

describe("fmt.range", () => {
  it("returns just the start when end is omitted", () => {
    expect(fmt.range("2026-04-28T13:00:00Z", undefined)).toBe(
      "2026-04-28 13:00:00 UTC",
    );
  });
  it("collapses to start → HH:MM:SS UTC for same-day ranges", () => {
    expect(fmt.range("2026-04-28T13:00:00Z", "2026-04-28T13:01:30Z")).toBe(
      "2026-04-28 13:00:00 UTC → 13:01:30 UTC",
    );
  });
  it("renders both full timestamps for cross-day ranges", () => {
    const out = fmt.range("2026-04-28T13:00:00Z", "2026-04-29T13:00:00Z");
    expect(out).toContain("2026-04-28 13:00:00 UTC");
    expect(out).toContain("2026-04-29 13:00:00 UTC");
  });
  it("falls back to two formatted timestamps when either is unparseable", () => {
    const out = fmt.range("nope", "2026-04-29T13:00:00Z");
    expect(out).toContain("→");
  });
});
