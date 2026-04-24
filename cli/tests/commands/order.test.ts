import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerOrderCommand } from "../../src/commands/order.js";

const mockPlaceOrder = vi.fn();
const mockGetActiveOrders = vi.fn();
const mockGetHistoricalOrders = vi.fn();
const mockGetOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAllOrders = vi.fn();
const mockGetOrderFills = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    placeOrder: mockPlaceOrder,
    getActiveOrders: mockGetActiveOrders,
    getHistoricalOrders: mockGetHistoricalOrders,
    getOrder: mockGetOrder,
    cancelOrder: mockCancelOrder,
    cancelAllOrders: mockCancelAllOrders,
    getOrderFills: mockGetOrderFills,
  })),
}));

vi.mock("../../src/util/parse.js", () => ({
  parseTimestamp: vi.fn((val) => Number(val)),
  parsePositiveInt: vi.fn((val) => Number(val)),
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
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

const sampleOrder = {
  id: "order-123",
  client_order_id: "client-123",
  symbol: "BTC-USD",
  side: "buy",
  type: "limit",
  quantity: "0.001",
  filled_quantity: "0.0",
  leaves_quantity: "0.001",
  price: "95000",
  average_fill_price: null,
  status: "new",
  reject_reason: null,
  time_in_force: "gtc",
  execution_instructions: [],
  created_date: 1700000000000,
  updated_date: 1700000000000,
  previous_order_id: null,
  conditional: null,
  take_profit: null,
  stop_loss: null,
};

function makeProgram() {
  const program = new Command().exitOverride();
  registerOrderCommand(program);
  return program;
}

describe("order place", () => {
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
    mockPlaceOrder.mockResolvedValue({
      data: {
        venue_order_id: "v-abc",
        client_order_id: "c-abc",
        state: "pending_new",
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("places a market buy order with base quantity", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      symbol: "BTC-USD",
      side: "buy",
      market: { baseSize: "0.001" },
    });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("v-abc");
  });

  it("places a limit sell order", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "sell",
      "--qty",
      "0.001",
      "--limit",
      "100000",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      symbol: "BTC-USD",
      side: "sell",
      limit: { price: "100000", baseSize: "0.001" },
    });
  });

  it("places a market buy order with quote amount", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--quote",
      "500",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      symbol: "BTC-USD",
      side: "buy",
      market: { quoteSize: "500" },
    });
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "btc-usd",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC-USD" }),
    );
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--market",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data.venue_order_id).toBe("v-abc");
  });

  it("exits with error for invalid side", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "sideways",
        "--qty",
        "0.001",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("buy");
  });

  it("exits with error when neither --qty nor --quote is provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when both --qty and --quote are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--quote",
        "500",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when neither --limit nor --market is specified", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("order open", () => {
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
    mockGetActiveOrders.mockResolvedValue({ data: [sampleOrder] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists open orders", async () => {
    await program.parseAsync(["node", "revx", "order", "open"]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith({});
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
  });

  it("filters by --symbols option", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "open",
      "--symbols",
      "BTC-USD,ETH-USD",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD", "ETH-USD"] }),
    );
  });

  it("passes advanced filter options to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "open",
      "--order-states",
      "new,partially_filled",
      "--order-types",
      "limit,conditional",
      "--side",
      "buy",
      "--limit",
      "10",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderStates: ["new", "partially_filled"],
        orderTypes: ["limit", "conditional"],
        side: "buy",
        limit: 10,
      }),
    );
  });

  it("shows empty message when no open orders", async () => {
    mockGetActiveOrders.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No open orders found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "order", "open", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].symbol).toBe("BTC-USD");
  });

  it("displays created timestamp in the output", async () => {
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("2023-11-14T22:13:20");
  });
});

describe("order history", () => {
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
    mockGetHistoricalOrders.mockResolvedValue({
      data: [{ ...sampleOrder, status: "filled" }],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists historical orders", async () => {
    await program.parseAsync(["node", "revx", "order", "history"]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
    expect(output).toContain("Period: Default / Recent");
  });

  it("passes --symbols filter to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--symbols",
      "BTC-USD",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD"] }),
    );
  });

  it("passes advanced filter options and date ranges to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--order-states",
      "filled,cancelled",
      "--order-types",
      "market",
      "--start-date",
      "1715000000000",
      "--end-date",
      "1715086400000",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderStates: ["filled", "cancelled"],
        orderTypes: ["market"],
        startDate: expect.any(Number),
      }),
    );
  });

  it("displays period subtitle in header when date ranges are provided", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      "1700000000000",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Period: Since");
  });

  it("shows empty message when no history found", async () => {
    mockGetHistoricalOrders.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No order history found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "order", "history", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].status).toBe("filled");
  });

  it("fetches all pages automatically within a date window", async () => {
    const orderA = { ...sampleOrder, id: "order-page1", status: "filled" };
    const orderB = { ...sampleOrder, id: "order-page2", status: "filled" };
    mockGetHistoricalOrders.mockResolvedValue({
      data: [orderA, orderB],
      metadata: {},
    });
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      "1715000000000",
      "--end-date",
      "1715086400000",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-page1");
    expect(output).toContain("order-page2");
  });

  it("handles long date ranges", async () => {
    const startMs = 1715040000000; // 2024-05-07
    const endMs = startMs + 61 * 24 * 60 * 60 * 1000; // 61 days

    mockGetHistoricalOrders.mockResolvedValue({
      data: [{ ...sampleOrder, status: "filled" }],
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      String(startMs),
      "--end-date",
      String(endMs),
    ]);

    expect(mockGetHistoricalOrders).toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("displays created timestamp in the output", async () => {
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("2023-11-14T22:13:20");
  });
});

describe("order get", () => {
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
    mockGetOrder.mockResolvedValue({ data: sampleOrder });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches order details by ID", async () => {
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    expect(mockGetOrder).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "get",
      "order-123",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data.id).toBe("order-123");
  });
});

describe("order cancel", () => {
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
    mockCancelOrder.mockResolvedValue(undefined);
    mockCancelAllOrders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("cancels a specific order by ID", async () => {
    await program.parseAsync(["node", "revx", "order", "cancel", "order-123"]);
    expect(mockCancelOrder).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("cancels all orders with --all flag", async () => {
    await program.parseAsync(["node", "revx", "order", "cancel", "--all"]);
    expect(mockCancelAllOrders).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("All open orders cancelled");
  });

  it("exits with error when no order ID and no --all", async () => {
    await expect(
      program.parseAsync(["node", "revx", "order", "cancel"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when both order ID and --all are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "cancel",
        "order-123",
        "--all",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("order fills", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const sampleFill = {
    id: "fill-1",
    symbol: "BTC-USD",
    side: "buy",
    price: "95000",
    quantity: "0.001",
    maker: false,
    timestamp: 1700000000000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetOrderFills.mockResolvedValue({ data: [sampleFill] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches fills for a given order ID", async () => {
    await program.parseAsync(["node", "revx", "order", "fills", "order-123"]);
    expect(mockGetOrderFills).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("fill-1");
  });

  it("shows empty message when no fills found", async () => {
    mockGetOrderFills.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "fills", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No fills found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "fills",
      "order-123",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].id).toBe("fill-1");
  });
});
