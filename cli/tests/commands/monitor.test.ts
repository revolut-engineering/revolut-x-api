import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { AuthenticationError } from "@revolut/revolut-x-api";

const started = vi.hoisted(() => ({
  specs: [] as Array<Record<string, unknown>>,
}));
const mockGetCurrencyPairs = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({ getCurrencyPairs: mockGetCurrencyPairs })),
}));

vi.mock("../../src/db/store.js", () => ({
  loadConnections: vi.fn(() => []),
}));

vi.mock("../../src/engine/monitor.js", () => ({
  TYPE_LABELS: {},
  ForegroundMonitor: class {
    static printBanner(): void {}

    constructor(spec: Record<string, unknown>) {
      started.specs.push(spec);
    }

    async run(): Promise<void> {}

    stop(): void {}
  },
}));

const { registerMonitorCommand } =
  await import("../../src/commands/monitor.js");

describe("monitor option checks", () => {
  let errors: string[];

  beforeEach(() => {
    started.specs = [];
    errors = [];
    mockGetCurrencyPairs.mockReset();
    mockGetCurrencyPairs.mockResolvedValue({
      "BTC/USD": { status: "active" },
      "OLD/USD": { status: "inactive" },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(process, "on").mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function monitor(...args: string[]) {
    const program = new Command().exitOverride();
    registerMonitorCommand(program);
    return program.parseAsync(["node", "revx", "monitor", ...args]);
  }

  it.each([
    [
      ["price", "BTC-USD", "--threshold", "100k"],
      '--threshold must be a number, got "100k".',
    ],
    [
      ["price", "BTC-USD", "--threshold", "100,000"],
      '--threshold must be a number, got "100,000".',
    ],
    [
      ["rsi", "BTC-USD", "--threshold", "150"],
      '--threshold must be above 0 and below 100, got "150".',
    ],
    [
      ["rsi", "BTC-USD", "--period", "0"],
      '--period must be from 2 to 99, got "0".',
    ],
    [
      ["rsi", "BTC-USD", "--period", "abc"],
      '--period must be a whole number, got "abc".',
    ],
    [
      ["ema-cross", "BTC-USD", "--fast-period", "50", "--slow-period", "5"],
      "--fast-period must be below --slow-period, got 50 and 5.",
    ],
    [
      ["macd", "BTC-USD", "--fast", "30"],
      "--fast must be below --slow, got 30 and 26.",
    ],
    [
      ["macd", "BTC-USD", "--signal", "1"],
      '--signal must be from 2 to 99, got "1".',
    ],
    [
      ["macd", "BTC-USD", "--slow", "90", "--signal", "20"],
      "--slow plus --signal can be at most 100, got 110.",
    ],
    [
      ["obi", "BTC-USD", "--threshold", "1.5"],
      '--threshold must be from -1 to 1, got "1.5".',
    ],
    [
      ["atr-breakout", "BTC-USD", "--multiplier", "-1"],
      '--multiplier must be above 0, got "-1".',
    ],
    [
      ["price-change", "BTC-USD", "--threshold", "-5"],
      '--threshold must be above 0, got "-5".',
    ],
    [
      ["price", "BTC-USD", "--threshold", "100000", "--interval", "2"],
      '--interval must be from 5 to 86400 seconds, got "2".',
    ],
  ])("refuses %j before contacting the exchange", async (args, message) => {
    // when
    const run = monitor(...args);

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(message);
    expect(mockGetCurrencyPairs).not.toHaveBeenCalled();
    expect(started.specs).toEqual([]);
  });

  it("refuses a pair that is not trading right now", async () => {
    // when
    const run = monitor("price", "OLD-USD", "--threshold", "1");

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(errors.join("\n")).toContain(
      "OLD-USD is not trading right now (status inactive).",
    );
    expect(started.specs).toEqual([]);
  });

  it("stops before the banner when the exchange refuses the key", async () => {
    // given
    mockGetCurrencyPairs.mockRejectedValue(
      new AuthenticationError("Unable to resolve API key"),
    );

    // when
    const run = monitor("price", "BTC-USD", "--threshold", "1");

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("Unable to resolve API key");
    expect(started.specs).toEqual([]);
  });

  it.each([
    [
      ["price", "BTC-USD", "--threshold", "100000"],
      { direction: "above", threshold: "100000" },
    ],
    [["rsi", "BTC-USD"], { direction: "above", threshold: "70", period: 14 }],
    [
      ["ema-cross", "BTC-USD"],
      { direction: "bullish", fast_period: 9, slow_period: 21 },
    ],
    [
      ["macd", "BTC-USD"],
      { direction: "bullish", fast: 12, slow: 26, signal: 9 },
    ],
    [["bollinger", "BTC-USD"], { band: "upper", period: 20, std_mult: "2" }],
    [["volume-spike", "BTC-USD"], { period: 20, multiplier: "2" }],
    [["spread", "BTC-USD"], { direction: "above", threshold: "0.5" }],
    [["obi", "BTC-USD"], { direction: "above", threshold: "0.3" }],
    [
      ["price-change", "BTC-USD"],
      { direction: "rise", threshold: "5", lookback: 24 },
    ],
    [["atr-breakout", "BTC-USD"], { period: 14, multiplier: "1.5" }],
  ])("starts %j with its defaults", async (args, config) => {
    // when
    await monitor(...args);

    // then
    expect(started.specs).toHaveLength(1);
    expect(started.specs[0].config).toEqual(config);
    expect(started.specs[0].intervalSec).toBe(10);
  });

  it("refuses a pair the exchange doesn't trade", async () => {
    // when
    const run = monitor("price", "ABC-USD", "--threshold", "1");

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(errors.join("\n")).toContain(
      "ABC-USD is not a trading pair on Revolut X. See the pairs with: revx market pairs",
    );
    expect(started.specs).toEqual([]);
  });

  it("starts with the checked values", async () => {
    // when
    await monitor(
      "price",
      "btc-usd",
      "--threshold",
      " 100000.50 ",
      "--interval",
      "30",
    );

    // then
    expect(started.specs).toEqual([
      {
        pair: "BTC-USD",
        alertType: "price",
        config: { direction: "above", threshold: "100000.5" },
        intervalSec: 30,
      },
    ]);
  });
});
