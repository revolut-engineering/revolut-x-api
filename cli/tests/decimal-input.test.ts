import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  decimalLimitProblem,
  groupedNumber,
  parseDecimal,
} from "../src/util/decimal-input.js";

describe("parseDecimal", () => {
  it.each([
    ["1e-7", "0.0000001"],
    [" 2.5E3 ", "2500"],
    ["+.5", "0.5"],
    ["5.", "5"],
    ["-12.75", "-12.75"],
  ])("reads %j as %s", (value, expected) => {
    expect(parseDecimal(value)?.toFixed()).toBe(expected);
  });

  it.each(["", "abc", "1e", "1e99999", "100k", "1,000", "0x10", "Infinity"])(
    "doesn't read %j",
    (value) => {
      expect(parseDecimal(value)).toBeNull();
    },
  );
});

describe("decimalLimitProblem", () => {
  it.each([
    ["999999999999999", null],
    ["1e15", "is too large"],
    ["0.000000000000000001", null],
    ["0.0000000000000000001", "has more than 18 decimal places"],
  ])("finds %s %s", (value, problem) => {
    expect(decimalLimitProblem(parseDecimal(value)!)).toBe(problem);
  });
});

describe("groupedNumber", () => {
  it.each([
    ["1234567.891", "1,234,567.891"],
    ["-1234.5", "-1,234.5"],
    ["-0", "0"],
    ["0.0000001", "0.0000001"],
    ["999", "999"],
  ])("writes %s as %s", (value, expected) => {
    expect(groupedNumber(new Decimal(value))).toBe(expected);
  });
});
