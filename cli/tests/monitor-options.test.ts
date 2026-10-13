import { describe, expect, it } from "vitest";
import {
  MonitorOptionError,
  decimalOption,
  intervalOption,
  periodOption,
} from "../src/util/monitor-options.js";

describe("decimalOption", () => {
  it.each(["100000", "0.5", ".5", "70.25", " 42 "])("accepts %s", (value) => {
    // when
    const result = decimalOption("--threshold", value, {});

    // then
    expect(result).toBe(String(Number(value)));
    expect(result).not.toContain("e");
  });

  it.each([
    ["1e-7", "0.0000001"],
    ["1E3", "1000"],
    ["+5", "5"],
    ["2.5e-3", "0.0025"],
  ])("accepts %s in exponent or signed form as %s", (value, expected) => {
    expect(decimalOption("--threshold", value, {})).toBe(expected);
  });

  it("refuses a value too large for a price", () => {
    expect(() => decimalOption("--threshold", "1e15", {})).toThrow(
      '--threshold is too large, got "1e15".',
    );
  });

  it("refuses more than 18 decimal places", () => {
    expect(() =>
      decimalOption("--threshold", "0.0000000000000000001", {}),
    ).toThrow(
      '--threshold has more than 18 decimal places, got "0.0000000000000000001".',
    );
  });

  it.each([
    "100k",
    "100,000",
    "abc",
    "",
    "1e",
    "1e99999",
    "0x10",
    "Infinity",
    "5%",
  ])("refuses %s as not a number", (value) => {
    // when
    const parse = () => decimalOption("--threshold", value, {});

    // then
    expect(parse).toThrow(MonitorOptionError);
    expect(parse).toThrow(`--threshold must be a number, got "${value}".`);
  });

  it("refuses a value that is not above the lower bound", () => {
    // when
    const parse = () => decimalOption("--threshold", "0", { above: 0 });

    // then
    expect(parse).toThrow('--threshold must be above 0, got "0".');
  });

  it("refuses a value outside an inclusive range", () => {
    expect(() =>
      decimalOption("--threshold", "-1.5", { min: -1, max: 1 }),
    ).toThrow('--threshold must be from -1 to 1, got "-1.5".');
    expect(decimalOption("--threshold", "-1", { min: -1, max: 1 })).toBe("-1");
  });

  it("refuses a value outside an exclusive range", () => {
    expect(() =>
      decimalOption("--threshold", "150", { above: 0, below: 100 }),
    ).toThrow('--threshold must be above 0 and below 100, got "150".');
  });

  it("refuses a negative value where none is allowed", () => {
    expect(() => decimalOption("--threshold", "-5", { min: 0 })).toThrow(
      '--threshold must be at least 0, got "-5".',
    );
  });

  it("keeps small numbers in plain notation", () => {
    expect(decimalOption("--threshold", "0.00000005", {})).toBe("0.00000005");
  });
});

describe("periodOption", () => {
  it("accepts a whole number in range", () => {
    expect(periodOption("--period", "14")).toBe(14);
  });

  it.each(["abc", "1.5", "-3", ""])("refuses %s", (value) => {
    expect(() => periodOption("--period", value)).toThrow(
      `--period must be a whole number, got "${value}".`,
    );
  });

  it("refuses 0 and anything the last 100 hourly candles can't cover", () => {
    expect(() => periodOption("--period", "0")).toThrow(
      '--period must be from 1 to 99, got "0".',
    );
    expect(() => periodOption("--period", "100")).toThrow(
      '--period must be from 1 to 99, got "100". The monitor reads the last 100 hourly candles.',
    );
  });

  it("honours a higher minimum", () => {
    expect(() => periodOption("--period", "1", 2)).toThrow(
      '--period must be from 2 to 99, got "1".',
    );
  });
});

describe("intervalOption", () => {
  it("accepts 5 seconds or more", () => {
    expect(intervalOption("5")).toBe(5);
    expect(intervalOption("30")).toBe(30);
  });

  it.each(["2", "0", "86401", "99999999999"])(
    "refuses %s seconds instead of adjusting it",
    (value) => {
      expect(() => intervalOption(value)).toThrow(
        `--interval must be from 5 to 86400 seconds, got "${value}".`,
      );
    },
  );

  it.each(["abc", "1.5", "30s"])("refuses %s", (value) => {
    expect(() => intervalOption(value)).toThrow(
      `--interval must be a whole number of seconds, got "${value}".`,
    );
  });
});
