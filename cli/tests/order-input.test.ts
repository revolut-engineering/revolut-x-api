import { describe, expect, it } from "vitest";
import {
  OrderInputError,
  assertOnPriceStep,
  orderAmount,
} from "../src/util/order-input.js";

describe("orderAmount signs", () => {
  it.each(["-0", "-1e3", "-0.5"])("refuses %s as not positive", (value) => {
    expect(() => orderAmount("--qty", value)).toThrow(
      `--qty must be a positive number, got "${value}".`,
    );
  });

  it("refuses +0 as zero", () => {
    expect(() => orderAmount("--qty", "+0")).toThrow(
      '--qty must be greater than 0, got "+0".',
    );
  });
});

describe("orderAmount", () => {
  it.each([
    ["0.001", "0.001"],
    [" 100 ", "100"],
    ["1e3", "1000"],
    ["1E-8", "0.00000001"],
    [".5", "0.5"],
    ["+2", "2"],
  ])("reads %j as %j", (value, expected) => {
    expect(orderAmount("--qty", value)).toBe(expected);
  });

  it.each(["0x10", "Infinity", "NaN", "", " ", "1,5", "abc", "-1", "1e"])(
    "refuses %j and names the flag",
    (value) => {
      expect(() => orderAmount("--qty", value)).toThrow(OrderInputError);
      expect(() => orderAmount("--qty", value)).toThrow(
        `--qty must be a positive number, got "${value}".`,
      );
    },
  );

  it.each([
    ["1e15", "--qty is too large"],
    ["1e9999", "--qty is too large"],
    ["1e-19", "--qty has more than 18 decimal places"],
    ["0.0000000000000000001", "--qty has more than 18 decimal places"],
  ])("refuses %j quickly with a clear reason", (value, reason) => {
    expect(() => orderAmount("--qty", value)).toThrow(reason);
  });

  it("refuses an exponent too long to read", () => {
    expect(() => orderAmount("--qty", "1e99999")).toThrow(
      '--qty must be a positive number, got "1e99999".',
    );
  });

  it.each(["0", "0.000", "0e5"])("refuses zero written as %j", (value) => {
    expect(() => orderAmount("--limit", value)).toThrow(
      `--limit must be greater than 0, got "${value}".`,
    );
  });
});

describe("assertOnPriceStep", () => {
  it.each(["95000", "95000.01", "0.01"])(
    "accepts %j on a 0.01 step",
    (price) => {
      expect(() =>
        assertOnPriceStep("--limit", price, "0.01", "BTC-USD"),
      ).not.toThrow();
    },
  );

  it("refuses a price between steps and names both neighbours", () => {
    expect(() =>
      assertOnPriceStep("--limit", "95000.015", "0.01", "BTC-USD"),
    ).toThrow(
      "--limit 95000.015 is not a multiple of the BTC-USD price step 0.01. The nearest valid prices are 95000.01 and 95000.02.",
    );
  });

  it("names only the step itself below the first step", () => {
    expect(() =>
      assertOnPriceStep("--price", "0.000001", "0.00001", "TURBO-USD"),
    ).toThrow("The nearest valid price is 0.00001.");
  });

  it("names exact neighbours for a price with many digits", () => {
    expect(() =>
      assertOnPriceStep("--limit", "95000.00999999999999999999", "0.01", "X"),
    ).toThrow("The nearest valid prices are 95000 and 95000.01.");
    expect(() =>
      assertOnPriceStep(
        "--limit",
        "100.0000000000000000000000000015",
        "1e-27",
        "X",
      ),
    ).toThrow(
      "The nearest valid prices are 100.000000000000000000000000001 and 100.000000000000000000000000002.",
    );
  });

  it.each([undefined, "", "abc", "-1"])(
    "checks nothing when the step is %j",
    (step) => {
      expect(() =>
        assertOnPriceStep("--limit", "1.23456", step, "X-USD"),
      ).not.toThrow();
    },
  );

  it("checks nothing when the pair has no step", () => {
    expect(() =>
      assertOnPriceStep("--limit", "1.23456", "0", "X-USD"),
    ).not.toThrow();
  });
});
