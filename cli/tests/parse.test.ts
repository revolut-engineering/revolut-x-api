import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTimestamp } from "../src/util/parse.js";

const FIXED_NOW = new Date("2025-06-15T12:30:00.000Z").getTime();

describe("parseTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns epoch ms numbers as-is", () => {
    expect(parseTimestamp("1700000000000")).toBe(1700000000000);
  });

  it("parses ISO date strings", () => {
    expect(parseTimestamp("2025-01-01")).toBe(new Date("2025-01-01").getTime());
  });

  it("parses ISO datetime strings", () => {
    expect(parseTimestamp("2025-01-01T00:00:00Z")).toBe(
      new Date("2025-01-01T00:00:00Z").getTime(),
    );
  });

  it("today returns midnight UTC of current day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("today");
    const expected = new Date("2025-06-15T00:00:00.000Z").getTime();
    expect(result).toBe(expected);
  });

  it("yesterday returns midnight UTC of previous day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("yesterday");
    const expected = new Date("2025-06-14T00:00:00.000Z").getTime();
    expect(result).toBe(expected);
  });

  it("7d returns 7 days ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("7d");
    expect(result).toBe(FIXED_NOW - 7 * 86400000);
  });

  it("3 days returns 3 days ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("3 days");
    expect(result).toBe(FIXED_NOW - 3 * 86400000);
  });

  it("1w returns 7 days ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("1w");
    expect(result).toBe(FIXED_NOW - 7 * 86400000);
  });

  it("2 weeks returns 14 days ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("2 weeks");
    expect(result).toBe(FIXED_NOW - 14 * 86400000);
  });

  it("4h returns 4 hours ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("4h");
    expect(result).toBe(FIXED_NOW - 4 * 3600000);
  });

  it("12 hours returns 12 hours ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("12 hours");
    expect(result).toBe(FIXED_NOW - 12 * 3600000);
  });

  it("30m returns 30 minutes ago from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("30m");
    expect(result).toBe(FIXED_NOW - 30 * 60000);
  });
});
