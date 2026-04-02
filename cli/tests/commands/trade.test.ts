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

vi.mock("api-k9x2a", () => ({
  RevolutXClient: vi.fn(),
  getConfigDir: () => "/tmp/revx-test",
  ensureConfigDir: () => {},
}));

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
    expect(mockGetPrivateTrades).toHaveBeenCalledWith("BTC-USD", {});
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("trade-1");
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync(["node", "revx", "trade", "private", "btc-usd"]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith("BTC-USD", {});
  });

  it("passes --limit to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--limit",
      "50",
    ]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("passes --cursor to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--cursor",
      "next-page-id",
    ]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ cursor: "next-page-id" }),
    );
  });

  it("passes --start-date and --end-date to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "private",
      "BTC-USD",
      "--start-date",
      "7d",
      "--end-date",
      "today",
    ]);
    expect(mockGetPrivateTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        startDate: 1600000000000,
        endDate: 1600000000000,
      }),
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

  it("displays cursor if returned via metadata.next_cursor", async () => {
    mockGetPrivateTrades.mockResolvedValue({
      data: [samplePrivateTrade],
      metadata: { next_cursor: "cursor-123" },
    });
    await program.parseAsync(["node", "revx", "trade", "private", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Next page cursor:");
    expect(output).toContain("cursor-123");
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
    expect(mockGetAllTrades).toHaveBeenCalledWith("BTC-USD", {});
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("pub-trade-1");
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync(["node", "revx", "trade", "public", "eth-usd"]);
    expect(mockGetAllTrades).toHaveBeenCalledWith("ETH-USD", {});
  });

  it("passes --limit to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--limit",
      "100",
    ]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("passes --cursor to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--cursor",
      "next-page-id",
    ]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ cursor: "next-page-id" }),
    );
  });

  it("passes --start-date and --end-date to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "trade",
      "public",
      "BTC-USD",
      "--start-date",
      "7d",
      "--end-date",
      "today",
    ]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({
        startDate: 1600000000000,
        endDate: 1600000000000,
      }),
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

  it("displays cursor if returned via metadata.next_cursor", async () => {
    mockGetAllTrades.mockResolvedValue({
      data: [samplePublicTrade],
      metadata: { next_cursor: "cursor-123" },
    });
    await program.parseAsync(["node", "revx", "trade", "public", "BTC-USD"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Next page cursor:");
    expect(output).toContain("cursor-123");
  });
});
