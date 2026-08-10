import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerStrategyCommand } from "../../src/commands/strategy.js";

const mockGetCurrencyPairs = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getCurrencyPairs: mockGetCurrencyPairs,
  })),
}));

const PAIRS = {
  "BTC/USD": {
    base: "BTC",
    quote: "USD",
    base_step: "0.001",
    quote_step: "0.1",
    min_order_size: "0.001",
    max_order_size: "100",
    min_order_size_quote: "1",
    slippage: 0,
    status: "active",
  },
};

describe("strategy machine output", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetCurrencyPairs.mockResolvedValue(PAIRS);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps backtest JSON as the only stdout record", async () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "backtest",
      "BTC-USD",
      "--levels",
      "1",
      "--range",
      "10",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
      "--json",
    ]);

    // then
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
    expect(error.mock.calls.flat().join("\n")).toContain("Loading scenario");
    expect(error.mock.calls.flat().join("\n")).toContain("Running backtest");
  });

  it("keeps optimizer JSON as the only stdout record", async () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "optimize",
      "BTC-USD",
      "--levels",
      "1",
      "--ranges",
      "10",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
      "--json",
    ]);

    // then
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
    expect(error.mock.calls.flat().join("\n")).toContain("Loading scenario");
    expect(error.mock.calls.flat().join("\n")).toContain("Testing 1 parameter");
  });

  it("places negative optimizer amounts before the currency symbol", async () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "optimize",
      "BTC-USD",
      "--levels",
      "1",
      "--ranges",
      "10",
      "--investment",
      "100",
      "--split",
      "--stop-loss",
      "80",
      "--prices",
      "inline:100,80",
    ]);
    const output = log.mock.calls.flat().join("\n");

    // then
    expect(output).toContain("-$");
    expect(output).not.toContain("$-");
  });

  it("shows the constraint-aligned quote allocation in the backtest summary", async () => {
    // given
    mockGetCurrencyPairs.mockResolvedValueOnce({
      "BTC/USD": {
        ...PAIRS["BTC/USD"],
        quote_step: "0.05",
      },
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "backtest",
      "BTC-USD",
      "--levels",
      "3",
      "--range",
      "10",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
    ]);
    const output = log.mock.calls.flat().join("\n");

    // then
    expect(output).toContain("$33.30");
    expect(output).not.toContain("$33.33");
  });
});
