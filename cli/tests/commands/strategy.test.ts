import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { AuthenticationError } from "@revolut/revolut-x-api";
import { registerStrategyCommand } from "../../src/commands/strategy.js";

const mockGetCurrencyPairs = vi.fn();

const mockGetCandles = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getCurrencyPairs: mockGetCurrencyPairs,
    getCandles: mockGetCandles,
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

function dailyCandles(count: number) {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.now() - count * day;
  return Array.from({ length: count }, (_, index) => {
    const price = String(100 + (index % 3) - 1);
    return {
      start: start + index * day,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: "1",
    };
  });
}

function backtestArgs(
  options: Record<string, string> = {},
  ...flags: string[]
): string[] {
  const values = {
    "--levels": "3",
    "--range": "5",
    "--investment": "100",
    ...options,
  };
  return [
    "node",
    "revx",
    "strategy",
    "grid",
    "backtest",
    "BTC-USD",
    ...Object.entries(values).flat(),
    ...flags,
  ];
}

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

  it("shows the summary for a split grid whose market buy only fits after the fee", async () => {
    // given
    mockGetCurrencyPairs.mockResolvedValueOnce({
      "BTC/USD": { ...PAIRS["BTC/USD"], max_order_size: "0.2997" },
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
      "5",
      "--investment",
      "60",
      "--split",
      "--prices",
      "inline:100,101,99",
    ]);
    const output = log.mock.calls.flat().join("\n");

    // then
    expect(output).toContain("GRID BACKTEST RESULTS");
  });

  it("leaves out the yearly figure for mock prices", async () => {
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
      "3",
      "--range",
      "5",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
    ]);
    const output = log.mock.calls.flat().join("\n");

    // then
    expect(output).toContain("GRID BACKTEST RESULTS");
    expect(output).not.toContain("Annualized");
  });

  it("reports no yearly figure in backtest JSON for mock prices", async () => {
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
      "3",
      "--range",
      "5",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
      "--json",
    ]);

    // then
    expect(log).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(log.mock.calls[0][0])).annualizedReturnPct,
    ).toBeNull();
  });

  it("reports no yearly or Calmar figure in optimize JSON for mock prices", async () => {
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
      "3",
      "--ranges",
      "5",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
      "--json",
    ]);

    // then
    expect(log).toHaveBeenCalledTimes(1);
    const [best] = JSON.parse(String(log.mock.calls[0][0]));
    expect(best.annualizedReturnPct).toBeNull();
    expect(best.calmarApprox).toBeNull();
  });

  it("shows return over drawdown instead of a yearly Calmar for mock prices", async () => {
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
      "3",
      "--ranges",
      "5",
      "--investment",
      "100",
      "--prices",
      "inline:100,101,99",
    ]);
    const output = log.mock.calls.flat().join("\n");

    // then
    expect(output).toContain("Return/DD");
    expect(output).not.toContain("Calmar");
  });

  it("shows no yearly figure for less than a year of candles", async () => {
    // given
    mockGetCandles.mockResolvedValue({ data: dailyCandles(4) });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(backtestArgs({ "--interval": "1d" }));
    const output = stripVTControlCharacters(log.mock.calls.flat().join("\n"));

    // then
    expect(output).toMatch(/Annualized\s+— \(needs a year of data\)/);
  });

  it("gives no yearly figure in JSON for less than a year of candles", async () => {
    // given
    mockGetCandles.mockResolvedValue({ data: dailyCandles(4) });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(backtestArgs({}, "--json"));

    // then
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      annualizedReturnPct: null,
    });
  });

  it("shows the yearly figure once the candles cover a year", async () => {
    // given
    mockGetCandles.mockResolvedValue({ data: dailyCandles(365) });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(
      backtestArgs({ "--days": "365", "--interval": "1d" }, "--json"),
    );

    // then
    expect(
      JSON.parse(String(log.mock.calls[0][0])).annualizedReturnPct,
    ).toEqual(expect.any(Number));
  });

  it("shows the yearly figure for a year of candles without the one still open", async () => {
    // given
    mockGetCandles.mockResolvedValue({ data: dailyCandles(364) });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(
      backtestArgs({ "--days": "365", "--interval": "1d" }, "--json"),
    );

    // then
    expect(
      JSON.parse(String(log.mock.calls[0][0])).annualizedReturnPct,
    ).toEqual(expect.any(Number));
  });

  it("ranks the optimizer's best risk-adjusted grid by return over drawdown for less than a year of candles", async () => {
    // given
    mockGetCandles.mockResolvedValue({ data: dailyCandles(30) });
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
      "3",
      "--ranges",
      "5",
      "--investment",
      "100",
      "--interval",
      "1d",
    ]);
    const output = stripVTControlCharacters(log.mock.calls.flat().join("\n"));

    // then
    expect(output).toContain("Return/DD");
    expect(output).not.toContain("Calmar");
  });

  it("gives the configure hint when the exchange refuses the key during a backtest", async () => {
    // given
    mockGetCandles.mockRejectedValue(
      new AuthenticationError("Unable to resolve API key"),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(backtestArgs());

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    const text = stripVTControlCharacters(error.mock.calls.flat().join("\n"));
    expect(text).toContain("✖ Error: Unable to resolve API key");
    expect(text).toContain("Run 'revx configure' to update your credentials.");
  });

  it("refuses a backtest below the pair minimum before fetching candles", async () => {
    // given
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(backtestArgs({ "--investment": "2" }));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(mockGetCandles).not.toHaveBeenCalled();
    expect(
      stripVTControlCharacters(error.mock.calls.flat().join("\n")),
    ).toContain("Quote per level 0.6 is below the minimum quote order size 1.");
  });

  it("refuses an optimization with any level count below the pair minimum before fetching candles", async () => {
    // given
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "optimize",
      "BTC-USD",
      "--levels",
      "1,3",
      "--ranges",
      "5",
      "--investment",
      "2",
    ]);

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(mockGetCandles).not.toHaveBeenCalled();
    expect(
      stripVTControlCharacters(error.mock.calls.flat().join("\n")),
    ).toContain("Quote per level 0.6 is below the minimum quote order size 1.");
  });

  it("keeps mock prices out of the help while the options still work", () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);
    const strategy = program.commands.find(
      (command) => command.name() === "strategy",
    )!;
    const grid = strategy.commands.find(
      (command) => command.name() === "grid",
    )!;
    const commands = [
      strategy,
      grid,
      ...["backtest", "optimize", "run"].map(
        (name) => grid.commands.find((command) => command.name() === name)!,
      ),
    ];

    // when
    const helps = commands.map((command) => {
      let help = "";
      command.configureOutput({ writeOut: (text) => (help += text) });
      command.outputHelp();
      return help;
    });
    const hiddenOptions = commands
      .slice(2)
      .flatMap((command) =>
        command.options.filter((option) =>
          ["--prices", "--trace"].includes(option.long ?? ""),
        ),
      );

    // then
    for (const help of helps) {
      expect(help).toContain("Usage:");
      expect(help).not.toMatch(/--prices|--trace|mock|grid-mock-prices/i);
    }
    expect(hiddenOptions.map((option) => option.long)).toEqual([
      "--prices",
      "--trace",
      "--prices",
      "--prices",
      "--trace",
    ]);
    expect(hiddenOptions.every((option) => option.hidden)).toBe(true);
  });

  it("keeps --json out of the grid run help", () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);
    const run = program.commands
      .find((command) => command.name() === "strategy")!
      .commands.find((command) => command.name() === "grid")!
      .commands.find((command) => command.name() === "run")!;
    let help = "";
    run.configureOutput({ writeOut: (text) => (help += text) });

    // when
    run.outputHelp();

    // then
    expect(help).not.toContain("--json");
  });

  it("keeps a gap after a long backtest label and shows the stop-loss like the dashboard", async () => {
    // given
    const start = Date.now() - 3 * 60 * 60 * 1000;
    mockGetCandles.mockResolvedValue({
      data: [100, 101, 99, 100].map((price, index) => ({
        start: start + index * 60 * 60 * 1000,
        open: String(price),
        high: String(price),
        low: String(price),
        close: String(price),
        volume: "1",
      })),
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
      "5",
      "--investment",
      "100",
      "--stop-loss",
      "70",
    ]);
    const output = stripVTControlCharacters(log.mock.calls.flat().join("\n"));

    // then
    expect(output).toMatch(/Stop-Loss {7}\$70\.00 {2}not triggered/);
    const columns = ["Pair", "Portfolio Value", "Stop-Loss"].map((label) => {
      const line = output.split("\n").find((row) => row.includes(label))!;
      const at = line.indexOf(label) + label.length;
      return at + line.slice(at).search(/\S/);
    });
    expect(new Set(columns).size).toBe(1);
  });

  it("describes trailing confirmation and immediate stop-loss", () => {
    // given
    const program = new Command();
    registerStrategyCommand(program);
    const strategy = program.commands.find(
      (command) => command.name() === "strategy",
    )!;
    const grid = strategy.commands.find(
      (command) => command.name() === "grid",
    )!;
    const backtest = grid.commands.find(
      (command) => command.name() === "backtest",
    )!;
    const optimize = grid.commands.find(
      (command) => command.name() === "optimize",
    )!;
    const run = grid.commands.find((command) => command.name() === "run")!;

    // when
    const backtestTrailing = backtest.options.find(
      (option) => option.long === "--trailing-up",
    )!;
    const optimizeTrailing = optimize.options.find(
      (option) => option.long === "--trailing-up",
    )!;
    const runTrailing = run.options.find(
      (option) => option.long === "--trailing-up",
    )!;
    const runStopLoss = run.options.find(
      (option) => option.long === "--stop-loss",
    )!;

    // then
    expect(backtestTrailing.description).toContain("second geometric level");
    expect(optimizeTrailing.description).toContain("second geometric level");
    expect(runTrailing.description).toContain("3 consecutive ticks");
    expect(runTrailing.description).toContain("second geometric level");
    for (const trailing of [backtestTrailing, optimizeTrailing, runTrailing]) {
      expect(trailing.description).toContain("once the grid holds no coins");
    }
    expect(runStopLoss.description).toContain("immediately");
  });
});
