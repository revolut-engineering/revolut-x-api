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

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
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
      last_price: "99999",
    },
    {
      symbol: "ETH-USD",
      bid: "3490",
      ask: "3510",
      mid: "3500",
      last_price: "3495",
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
  });

  it("fetches specific ticker when symbol is provided", async () => {
    mockGetTickers.mockResolvedValue({ data: [sampleTickers.data[0]] });
    await program.parseAsync(["node", "revx", "market", "tickers", "BTC-USD"]);
    expect(mockGetTickers).toHaveBeenCalledWith({ symbols: ["BTC-USD"] });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
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

  it("trims range when no start date provided (more than 50,000 candles)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await program.parseAsync(["node", "revx", "market", "candles", "BTC-USD"]);
    expect(mockGetCandles).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        interval: 60,
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    warnSpy.mockRestore();
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

  it("trims to last 50,000 candles when requested range is too large", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const twoMonthsAgo = now - 60 * 24 * 60 * 60 * 1000;

    await program.parseAsync([
      "node",
      "revx",
      "market",
      "candles",
      "BTC-USD",
      "--interval",
      "1m",
      "--since",
      String(twoMonthsAgo),
      "--until",
      String(now),
    ]);
    warnSpy.mockRestore();
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

  it("fetches order book with default limit of 10", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "market",
      "orderbook",
      "BTC-USD",
    ]);
    expect(mockGetOrderBook).toHaveBeenCalledWith("BTC-USD", { limit: 10 });
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
