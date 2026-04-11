import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerTradeCommand } from "../../src/commands/trade.js";

const mockGetPrivateTrades = vi.fn();
const mockGetAllTrades = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getPrivateTrades: mockGetPrivateTrades,
    getAllTrades: mockGetAllTrades,
  })),
}));

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    RevolutXClient: vi.fn(),
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
  };
});

vi.mock("../../src/util/parse.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/util/parse.js")>();
  return {
    ...actual,
    parseTimestamp: vi.fn(() => 1600000000000),
    parsePositiveInt: actual.parsePositiveInt,
  };
});

const samplePrivateTrade = {
  id: "trade-1",
  symbol: "BTC-USD",
  side: "buy",
  price: "95000",
  quantity: "0.001",
  maker: false,
  orderId: "order-1",
  timestamp: 1700000000000,
};

const samplePublicTrade = {
  id: "pub-trade-1",
  symbol: "BTC-USD",
  price: "95000",
  quantity: "0.002",
  timestamp: 1700000000000,
};

function makeProgram() {
  const program = new Command().exitOverride();
  registerTradeCommand(program);
  return program;
}

describe("trade private", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetPrivateTrades.mockResolvedValue({ data: [samplePrivateTrade] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches private trades for given symbol", async () => {
    await program.parseAsync(["node", "revx", "trade", "private", "BTC-USD"]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("trade-1");
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync(["node", "revx", "trade", "private", "btc-usd"]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({}),
    );
  });

  it("respects --limit by capping total results", async () => {
    const trade2 = { ...samplePrivateTrade, id: "trade-2" };
    const trade3 = { ...samplePrivateTrade, id: "trade-3" };
    mockGetPrivateTrades.mockResolvedValue({
      data: [samplePrivateTrade, trade2, trade3],
      metadata: {},
    });
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--limit",
      "2",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("trade-1");
    expect(output).toContain("trade-2");
    expect(output).not.toContain("trade-3");
  });

  it("passes --start-date to API as lower bound", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--start-date",
      "7d",
    ]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ startDate: expect.any(Number) }),
    );
  });

  it("shows empty message when no private trades found", async () => {
    mockGetPrivateTrades.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "trade", "private", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No private trades found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].id).toBe("trade-1");
  });

  it("fetches all pages automatically within a date window", async () => {
    const trade2 = { ...samplePrivateTrade, id: "trade-page2" };
    mockGetPrivateTrades
      .mockResolvedValueOnce({
        data: [samplePrivateTrade],
        metadata: { next_cursor: "cursor-xyz" },
      })
      .mockResolvedValueOnce({
        data: [trade2],
        metadata: {},
      });
    await program.parseAsync(["node", "revx", "trade", "private", "BTC-USD"]);
    expect(mockGetPrivateTrades).toHaveBeenCalledTimes(2);
    expect(mockGetPrivateTrades).toHaveBeenNthCalledWith(
      2,
      "BTC-USD",
      expect.objectContaining({ cursor: "cursor-xyz" }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("trade-1");
    expect(output).toContain("trade-page2");
  });

  it("displays orderId in the output", async () => {
    await program.parseAsync(["node", "revx", "trade", "private", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-1");
  });
});

describe("trade public", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetAllTrades.mockResolvedValue({ data: [samplePublicTrade] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches public trades for given symbol", async () => {
    await program.parseAsync(["node", "revx", "trade", "public", "BTC-USD"]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("pub-trade-1");
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync(["node", "revx", "trade", "public", "eth-usd"]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "ETH-USD",
      expect.objectContaining({}),
    );
  });

  it("respects --limit by capping total results", async () => {
    const trade2 = { ...samplePublicTrade, id: "pub-trade-2" };
    const trade3 = { ...samplePublicTrade, id: "pub-trade-3" };
    mockGetAllTrades.mockResolvedValue({
      data: [samplePublicTrade, trade2, trade3],
      metadata: {},
    });
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--limit",
      "2",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("pub-trade-1");
    expect(output).toContain("pub-trade-2");
    expect(output).not.toContain("pub-trade-3");
  });

  it("passes --start-date to API as lower bound", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--start-date",
      "7d",
    ]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ startDate: expect.any(Number) }),
    );
  });

  it("shows empty message when no public trades found", async () => {
    mockGetAllTrades.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "trade", "public", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No public trades found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].id).toBe("pub-trade-1");
  });

  it("fetches all pages automatically within a date window", async () => {
    const trade2 = { ...samplePublicTrade, id: "pub-trade-page2" };
    mockGetAllTrades
      .mockResolvedValueOnce({
        data: [samplePublicTrade],
        metadata: { next_cursor: "cursor-pub" },
      })
      .mockResolvedValueOnce({
        data: [trade2],
        metadata: {},
      });
    await program.parseAsync(["node", "revx", "trade", "public", "BTC-USD"]);
    expect(mockGetAllTrades).toHaveBeenCalledTimes(2);
    expect(mockGetAllTrades).toHaveBeenNthCalledWith(
      2,
      "BTC-USD",
      expect.objectContaining({ cursor: "cursor-pub" }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("pub-trade-1");
    expect(output).toContain("pub-trade-page2");
  });
});
