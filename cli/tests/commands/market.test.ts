import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerMarketCommand } from "../../src/commands/market.js";

const mockGetCurrencies = vi.fn();
const mockGetCurrencyPairs = vi.fn();
const mockGetTickers = vi.fn();
const mockGetCandles = vi.fn();
const mockGetOrderBook = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getCurrencies: mockGetCurrencies,
    getCurrencyPairs: mockGetCurrencyPairs,
    getTickers: mockGetTickers,
    getCandles: mockGetCandles,
    getOrderBook: mockGetOrderBook,
  })),
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class RevolutXError extends Error {}
  class AuthNotConfiguredError extends RevolutXError {}
  class AuthenticationError extends RevolutXError {}
  class RateLimitError extends RevolutXError {}
  class BadRequestError extends RevolutXError {}
  class NotFoundError extends RevolutXError {}
  class NetworkError extends RevolutXError {}
  return {
    ...actual,
    RevolutXClient: vi.fn(),
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
    RevolutXError,
    AuthNotConfiguredError,
    AuthenticationError,
    RateLimitError,
    BadRequestError,
    NotFoundError,
    NetworkError,
  };
});

const sampleCurrencies = {
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    asset_type: "crypto",
    scale: 8,
    status: "active",
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    asset_type: "crypto",
    scale: 18,
    status: "active",
  },
  USD: {
    symbol: "USD",
    name: "US Dollar",
    asset_type: "fiat",
    scale: 2,
    status: "active",
  },
};

const samplePairs = {
  "BTC/USD": {
    base: "BTC",
    quote: "USD",
    base_step: "0.00000001",
    quote_step: "0.01",
    min_order_size: "0.0001",
    max_order_size: "10",
    slippage: "0.01",
    status: "active",
  },
  "ETH/USD": {
    base: "ETH",
    quote: "USD",
    min_order_size: "0.001",
    max_order_size: "100",
    slippage: "0.01",
    status: "active",
  },
};

const sampleTickers = {
  data: [
    {
      symbol: "BTC-USD",
      bid: "99900",
      ask: "100100",
      mid: "100000",
      index_price: "100050",
      last_price: "99999",
      low_24h: "98000",
      high_24h: "101000",
      price_change_24h: "500",
      volume_24h: "12.34000000",
      quote_volume_24h: "1233987.66000000",
    },
    {
      symbol: "ETH-USD",
      bid: "3490",
      ask: "3510",
      mid: "3500",
      index_price: "3501",
      last_price: "3495",
      low_24h: "3400",
      high_24h: "3600",
      price_change_24h: "-25",
      volume_24h: "456.78000000",
      quote_volume_24h: "",
    },
  ],
};

function makeProgram() {
  const program = new Command().exitOverride();
  registerMarketCommand(program);
  return program;
}

describe("market currencies", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetCurrencies.mockResolvedValue(sampleCurrencies);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const fiatWithSigns = {
    USD: {
      symbol: "$",
      name: "US Dollar",
      asset_type: "fiat",
      scale: 2,
      status: "active",
    },
    GBP: {
      symbol: "£",
      name: "British Pound",
      asset_type: "fiat",
      scale: 2,
      status: "active",
    },
  };

  it("shows the currency code even when the symbol is a sign", async () => {
    mockGetCurrencies.mockResolvedValue(fiatWithSigns);

    await program.parseAsync(["node", "revx", "market", "currencies", "fiat"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("USD");
    expect(output).toContain("GBP");
  });

  it("filters by currency code, in any case", async () => {
    mockGetCurrencies.mockResolvedValue(fiatWithSigns);

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "currencies",
      "--filter",
      "usd",
      "--json",
    ]);

    expect(JSON.parse(logSpy.mock.calls.flat().join(" "))).toEqual([
      { code: "USD", ...fiatWithSigns.USD },
    ]);
  });

  it("lists all currencies", async () => {
    await program.parseAsync(["node", "revx", "market", "currencies"]);
    expect(mockGetCurrencies).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
    expect(output).toContain("USD");
  });

  it("filters currencies by type fiat", async () => {
    await program.parseAsync(["node", "revx", "market", "currencies", "fiat"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Fiat Currencies");
    expect(output).toContain("USD");
  });

  it("filters currencies by type crypto", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "currencies",
      "crypto",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Crypto Currencies");
    expect(output).toContain("BTC");
  });

  it("filters currencies by --filter symbols", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "currencies",
      "--filter",
      "BTC,ETH",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
    expect(output).toContain("ETH");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "currencies",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
  });

  it("exits with error for invalid currency type", async () => {
    await expect(
      program.parseAsync(["node", "revx", "market", "currencies", "invalid"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("invalid");
  });

  it("exits with error when --filter matches nothing", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "currencies",
        "--filter",
        "DOGE",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("market pairs", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetCurrencyPairs.mockResolvedValue(samplePairs);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists all trading pairs", async () => {
    await program.parseAsync(["node", "revx", "market", "pairs"]);
    expect(mockGetCurrencyPairs).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
    expect(output).toContain("USD");
  });

  it("shows the size and price steps", async () => {
    await program.parseAsync(["node", "revx", "market", "pairs"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Size Step");
    expect(output).toContain("Price Step");
    expect(output).toContain("0.00000001");
    expect(output).toContain("0.01");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "market", "pairs", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
  });

  it("exits with error when --filter matches nothing", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "pairs",
        "--filter",
        "XRP-USD",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("market tickers", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetTickers.mockResolvedValue(sampleTickers);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists all tickers", async () => {
    await program.parseAsync(["node", "revx", "market", "tickers"]);
    expect(mockGetTickers).toHaveBeenCalledWith(undefined);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
    expect(output).toContain("ETH-USD");
    expect(output).toContain("Index");
    expect(output).toContain("100050");
    expect(output).toContain("98000");
    expect(output).toContain("101000");
    expect(output).toContain("500");
    expect(output).toContain("Volume 24h");
    expect(output).toContain("12.34000000");
    expect(output).toContain("Quote Vol 24h");
    expect(output).toContain("1233987.66000000");
  });

  it("fetches specific ticker when symbol is provided", async () => {
    mockGetTickers.mockResolvedValue({ data: [sampleTickers.data[0]] });
    await program.parseAsync(["node", "revx", "market", "tickers", "BTC-USD"]);
    expect(mockGetTickers).toHaveBeenCalledWith({ symbols: ["BTC-USD"] });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
    expect(output).toContain("Index");
    expect(output).toContain("100050");
    expect(output).toContain("Low 24h");
    expect(output).toContain("98000");
    expect(output).toContain("High 24h");
    expect(output).toContain("101000");
    expect(output).toContain("Change 24h");
    expect(output).toContain("500");
    expect(output).toContain("Volume 24h");
    expect(output).toContain("12.34000000");
    expect(output).toContain("Quote Vol 24h");
    expect(output).toContain("1233987.66000000");
  });

  it("filters by --symbols option", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "tickers",
      "--symbols",
      "BTC-USD,ETH-USD",
    ]);
    expect(mockGetTickers).toHaveBeenCalledWith({
      symbols: ["BTC-USD", "ETH-USD"],
    });
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "market", "tickers", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toMatchObject({
      index_price: "100050",
      low_24h: "98000",
      high_24h: "101000",
      price_change_24h: "500",
      volume_24h: "12.34000000",
      quote_volume_24h: "1233987.66000000",
    });
  });

  it("exits with error when specific ticker returns no data", async () => {
    mockGetTickers.mockResolvedValue({ data: [] });
    await expect(
      program.parseAsync(["node", "revx", "market", "tickers", "UNKNOWN"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("market candles", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const sampleCandles = {
    data: [
      {
        start: 1700000000000,
        open: "99000",
        high: "101000",
        low: "98000",
        close: "100000",
        volume: "500",
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetCandles.mockResolvedValue(sampleCandles);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the last 100 candles when no --since is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();

    await program.parseAsync(["node", "revx", "market", "candles", "BTC-USD"]);

    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 60,
      startDate: now - 100 * HOUR,
      endDate: now,
    });
  });

  it("ends a future --until at now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--since",
      "7d",
      "--until",
      String(now + 30 * 24 * HOUR),
    ]);

    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 60,
      startDate: now - 7 * 24 * HOUR,
      endDate: now,
    });
  });

  it("keeps exactly 50,000 candles without a note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const until = Date.now() - HOUR;

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "1m",
      "--since",
      String(until - 50_000 * 60_000),
      "--until",
      String(until),
    ]);

    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 1,
      startDate: until - 50_000 * 60_000,
      endDate: until,
    });
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("Only the last");
  });

  it("reads the 100 candles before --until when only --until is given", async () => {
    const until = 1_780_000_000_000;

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--until",
      String(until),
    ]);

    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 60,
      startDate: until - 100 * HOUR,
      endDate: until,
    });
  });

  it("refuses a --since in the future", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "candles",
        "BTC-USD",
        "--since",
        "2999-01-01",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "--since is in the future.",
    );
    expect(mockGetCandles).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("says on stderr when JSON output was capped", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const until = 1_780_000_000_000;

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "1m",
      "--since",
      String(until - 60 * 24 * HOUR),
      "--until",
      String(until),
      "--json",
    ]);

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "Only the last 50000 candles of that range are shown.",
    );
    expect(() => JSON.parse(logSpy.mock.calls.flat().join(" "))).not.toThrow();
    errSpy.mockRestore();
  });

  it("refuses --since after --until", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "candles",
        "BTC-USD",
        "--since",
        "1d",
        "--until",
        "7d",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "--since must be before --until.",
    );
    expect(mockGetCandles).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("fetches candles with default 1h interval (60 minutes)", async () => {
    await program.parseAsync(["node", "revx", "market", "candles", "BTC-USD"]);
    expect(mockGetCandles).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ interval: 60 }),
    );
  });

  it("resolves interval aliases (4h → 240 minutes)", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "4h",
    ]);
    expect(mockGetCandles).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ interval: 240 }),
    );
  });

  it("resolves interval aliases (1d → 1440 minutes)", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "1d",
    ]);
    expect(mockGetCandles).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ interval: 1440 }),
    );
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync(["node", "revx", "market", "candles", "btc-usd"]);
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", expect.anything());
  });

  it("displays table with candle data", async () => {
    await program.parseAsync(["node", "revx", "market", "candles", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("100000");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(1);
  });

  it("respects provided since/until dates when within 50,000 candle limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000; // 1 hour = 1 candle at 1h interval

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--since",
      String(oneHourAgo),
      "--until",
      String(now),
    ]);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockGetCandles).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        interval: 60,
        startDate: oneHourAgo,
        endDate: now,
      }),
    );
    warnSpy.mockRestore();
  });

  it("keeps the end of a range longer than 50,000 candles and says so", async () => {
    const until = 1_780_000_000_000;
    const twoMonthsEarlier = until - 60 * 24 * HOUR;

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "1m",
      "--since",
      String(twoMonthsEarlier),
      "--until",
      String(until),
    ]);

    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 1,
      startDate: until - 50_000 * 60_000,
      endDate: until,
    });
    expect(logSpy.mock.calls.flat().join(" ")).toContain(
      "Only the last 50000 candles of that range are shown.",
    );
  });
});

describe("market orderbook", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const sampleOrderBook = {
    data: {
      asks: [
        { price: "100100", quantity: "0.5", orderCount: 3 },
        { price: "100200", quantity: "1.0", orderCount: 5 },
      ],
      bids: [
        { price: "99900", quantity: "0.8", orderCount: 2 },
        { price: "99800", quantity: "1.2", orderCount: 4 },
      ],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetOrderBook.mockResolvedValue(sampleOrderBook);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches order book with default limit of 50", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
    ]);
    expect(mockGetOrderBook).toHaveBeenCalledWith("BTC-USD", { limit: 50 });
  });

  it("fetches order book with custom --limit", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
      "--limit",
      "5",
    ]);
    expect(mockGetOrderBook).toHaveBeenCalledWith("BTC-USD", { limit: 5 });
  });

  it("accepts the maximum depth of 192", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
      "--limit",
      "192",
    ]);
    expect(mockGetOrderBook).toHaveBeenCalledWith("BTC-USD", { limit: 192 });
  });

  it("rejects a limit above 192 instead of clamping", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "orderbook",
        "BTC-USD",
        "--limit",
        "193",
      ]),
    ).rejects.toThrow("process.exit");
    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "--limit must be an integer between 1 and 192",
    );
    expect(mockGetOrderBook).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rejects a limit below 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "market",
        "orderbook",
        "BTC-USD",
        "--limit",
        "0",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockGetOrderBook).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("displays asks and bids in table output", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("100100");
    expect(output).toContain("99900");
    expect(output.indexOf("100100")).toBeLessThan(output.indexOf("100200"));
    expect(output.indexOf("99900")).toBeLessThan(output.indexOf("99800"));
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data.asks).toHaveLength(2);
    expect(parsed.data.bids).toHaveLength(2);
  });
});
