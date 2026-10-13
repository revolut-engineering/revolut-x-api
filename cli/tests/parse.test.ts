import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDateRange,
  parseTimestamp,
  resolveDateWindow,
} from "../src/util/parse.js";

const FIXED_NOW = new Date("2025-06-15T12:30:00.000Z").getTime();

describe("parseTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns epoch ms numbers as-is", () => {
    expect(parseTimestamp("1700000000000")).toBe(1700000000000);
  });

  it("parses bare date strings as local midnight", () => {
    expect(parseTimestamp("2025-01-01")).toBe(new Date(2025, 0, 1).getTime());
  });

  it("parses ISO datetime strings", () => {
    expect(parseTimestamp("2025-01-01T00:00:00Z")).toBe(
      new Date("2025-01-01T00:00:00Z").getTime(),
    );
  });

  it("today returns local midnight of current day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("today");
    const expected = new Date(FIXED_NOW);
    expected.setHours(0, 0, 0, 0);
    expect(result).toBe(expected.getTime());
  });

  it("yesterday returns local midnight of previous day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const result = parseTimestamp("yesterday");
    const expected = new Date(FIXED_NOW);
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - 1);
    expect(result).toBe(expected.getTime());
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

describe("strict dates", () => {
  const FORMATS =
    "Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, a relative time like 7d, today, yesterday or epoch milliseconds.";

  it.each([
    "2026-13-45",
    "2026-02-30",
    "2026-00-00",
    "2026-02-30T10:00",
    "2026-10-12T25:00",
    "",
    "   ",
    "-5",
    "1e3",
    "2026",
    "March 5 2026",
  ])("refuses %j", (value) => {
    expect(() => parseTimestamp(value)).toThrow(
      `Invalid date: "${value}". ${FORMATS}`,
    );
  });

  it("names epoch seconds as the likely mistake", () => {
    expect(() => parseTimestamp("1700000000")).toThrow(
      'Invalid date: "1700000000". It looks like epoch seconds. Use milliseconds, for example 1700000000000.',
    );
  });

  it("reads a date and time without a zone as local time", () => {
    expect(parseTimestamp("2026-10-12T10:30")).toBe(
      new Date(2026, 9, 12, 10, 30).getTime(),
    );
    expect(parseTimestamp("2026-10-12 10:30:15")).toBe(
      new Date(2026, 9, 12, 10, 30, 15).getTime(),
    );
  });

  it("reads a date and time with a zone offset", () => {
    expect(parseTimestamp("2026-10-12T10:30:00+02:00")).toBe(
      Date.UTC(2026, 9, 12, 8, 30),
    );
    expect(parseTimestamp("2026-10-12T10:30+0200")).toBe(
      Date.UTC(2026, 9, 12, 8, 30),
    );
    expect(parseTimestamp("2026-10-12T10:30:00.5Z")).toBe(
      Date.UTC(2026, 9, 12, 10, 30, 0, 500),
    );
  });

  it("refuses an impossible zone offset", () => {
    expect(() => parseTimestamp("2026-10-12T10:30+99:99")).toThrow(
      "Invalid date",
    );
  });

  it("accepts the last day of a leap February", () => {
    expect(parseTimestamp("2028-02-29")).toBe(new Date(2028, 1, 29).getTime());
  });
});

describe("parseDateRange", () => {
  it("returns both ends when the start is not after the end", () => {
    expect(parseDateRange("2026-01-01", "2026-01-02")).toEqual({
      start: new Date(2026, 0, 1).getTime(),
      end: new Date(2026, 0, 2).getTime(),
    });
    expect(parseDateRange("2026-01-01", "2026-01-01").start).toBe(
      new Date(2026, 0, 1).getTime(),
    );
  });

  it("leaves out an end that wasn't given", () => {
    expect(parseDateRange(undefined, "2026-01-02")).toEqual({
      start: undefined,
      end: new Date(2026, 0, 2).getTime(),
    });
  });

  it("refuses a start after the end, naming both options", () => {
    expect(() => parseDateRange("1d", "7d")).toThrow(
      "--start-date must be before --end-date.",
    );
    expect(() =>
      parseDateRange("2026-01-02", "2026-01-01", ["--since", "--until"]),
    ).toThrow("--since must be before --until.");
  });
});

describe("long fractions, clock changes and far values", () => {
  const previousTz = process.env.TZ;

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("keeps milliseconds from a fraction with up to 9 digits", () => {
    expect(parseTimestamp("2026-10-12T10:30:00.123456Z")).toBe(
      Date.UTC(2026, 9, 12, 10, 30, 0, 123),
    );
  });

  it("refuses a local time that the clock skips", () => {
    process.env.TZ = "Europe/London";
    expect(() => parseTimestamp("2026-03-29T01:30")).toThrow(
      'Invalid date: "2026-03-29T01:30". That local time doesn\'t exist, because the clock changes then.',
    );
    expect(parseTimestamp("2026-03-29T03:30")).toBe(
      Date.UTC(2026, 2, 29, 2, 30),
    );
  });

  it("moves a date whose midnight the clock skips to the first valid time", () => {
    process.env.TZ = "America/Santiago";
    expect(parseTimestamp("2026-09-06")).toBe(Date.UTC(2026, 8, 6, 4));
    expect(() => parseTimestamp("2026-09-06T00:30")).toThrow(
      "That local time doesn't exist",
    );
  });

  it("refuses a day the time zone skipped", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(() => parseTimestamp("1994-12-31T12:00")).toThrow(
      "That local time doesn't exist",
    );
  });

  it("refuses an absolute date before 1970", () => {
    expect(() => parseTimestamp("1969-12-31T00:00Z")).toThrow(
      'Invalid date: "1969-12-31T00:00Z". That is before 1970.',
    );
  });

  it("refuses a relative time that reaches before 1970", () => {
    expect(() => parseTimestamp("99999999999d")).toThrow(
      'Invalid date: "99999999999d". That is before 1970.',
    );
  });
});

describe("resolveDateWindow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a window in the future at now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    expect(resolveDateWindow("2025-06-01", "2030-01-01", 0)).toEqual({
      start: new Date(2025, 5, 1).getTime(),
      end: FIXED_NOW,
      givenStart: new Date(2025, 5, 1).getTime(),
      givenEnd: new Date(2030, 0, 1).getTime(),
    });
  });

  it("starts a window without a start one span before its end", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    expect(resolveDateWindow(undefined, undefined, 1000)).toMatchObject({
      start: FIXED_NOW - 1000,
      end: FIXED_NOW,
    });
  });

  it("refuses a start in the future", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    expect(() => resolveDateWindow("2030-01-01", undefined, 0)).toThrow(
      "--start-date is in the future.",
    );
  });
});
