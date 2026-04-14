import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTradingTools } from "../../src/tools/trading.js";
import { vi, describe, beforeEach, it, expect } from "vitest";

const mockClient = {
  getActiveOrders: vi.fn(),
  getHistoricalOrders: vi.fn(),
  getPrivateTrades: vi.fn(),
  getOrderFills: vi.fn(),
  getOrder: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class AuthNotConfiguredError extends Error {
    name = "AuthNotConfiguredError";
  }
  class RateLimitError extends Error {
    name = "RateLimitError";
    retryAfter?: number;
    constructor(message = "Rate limit exceeded", retryAfter?: number) {
      super(message);
      this.retryAfter = retryAfter;
    }
  }
  class ServerError extends Error {
    name = "ServerError";
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    ...actual,
    AuthNotConfiguredError,
    RateLimitError,
    ServerError,
  };
});

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTradingTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

describe("trading read-only tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("get_active_orders returns formatted list", async () => {
    mockClient.getActiveOrders.mockResolvedValue({
      data: [
        {
          id: "order-1",
          client_order_id: "co-1",
          symbol: "BTC-USD",
          side: "buy",
          type: "limit",
          price: "90000",
          quantity: "0.1",
          filled_quantity: "0",
          leaves_quantity: "0.1",
          status: "new",
          time_in_force: "gtc",
          execution_instructions: [],
          created_date: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_active_orders",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("order-1");
    expect(text).toContain("90000");
  });

  it("get_historical_orders returns formatted list", async () => {
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [
        {
          id: "hist-1",
          client_order_id: "co-hist-1",
          symbol: "BTC-USD",
          side: "buy",
          type: "limit",
          price: "92000",
          average_fill_price: "91500",
          quantity: "0.5",
          filled_quantity: "0.5",
          leaves_quantity: "0",
          status: "filled",
          time_in_force: "GTC",
          created_date: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Historical orders (");
    expect(text).toContain("hist-1");
    expect(text).toContain("92000");
    expect(text).toContain("Avg Fill Price: 91500");
  });

  it("get_historical_orders handles empty result", async () => {
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {},
    });
    expect(getText(result)).toContain("No historical orders found");
  });

  it("get_historical_orders returns setup guide on auth error", async () => {
    const { AuthNotConfiguredError } = await import("api-k9x2a");
    mockClient.getHistoricalOrders.mockRejectedValue(
      new AuthNotConfiguredError(),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {},
    });
    expect(getText(result)).toContain("Setup guide text");
  });

  it("get_historical_orders validates symbol when provided", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: { symbols: ["bad"] },
    });
    const text = getText(result);
    expect(text).toContain("Invalid");
    expect(text).toContain("symbol");
  });

  it("get_historical_orders validates date formats", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: { start_date: "invalid-date" },
    });
    expect(getText(result)).toContain("Invalid date format");
  });

  it("get_historical_orders passes symbol and date filters", async () => {
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();

    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {
        symbols: ["ETH-EUR"],
      },
    });

    expect(getText(result)).toContain("No historical orders found");
    expect(mockClient.getHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        symbols: ["ETH-EUR"],
      }),
    );
  });

  it("get_historical_orders fetches all pages automatically", async () => {
    const orderA = {
      id: "hist-page1",
      client_order_id: "co-p1",
      symbol: "ETH-USD",
      side: "sell",
      type: "market",
      quantity: "1",
      filled_quantity: "1",
      leaves_quantity: "0",
      status: "filled",
      time_in_force: "ioc",
      created_date: 1700000000000,
    };
    const orderB = { ...orderA, id: "hist-page2", client_order_id: "co-p2" };
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [orderA, orderB],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("hist-page1");
    expect(text).toContain("hist-page2");
  });

  it("get_historical_orders handles long date ranges", async () => {
    const order = {
      id: "batch-order",
      client_order_id: "co-batch",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      quantity: "1",
      filled_quantity: "1",
      leaves_quantity: "0",
      status: "filled",
      time_in_force: "gtc",
      created_date: 1700000000000,
    };

    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [order],
      metadata: { timestamp: 1700000000000 },
    });

    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {
        start_date: "90d",
      },
    });

    const text = getText(result);
    expect(text).toContain("batch-order");
    expect(mockClient.getHistoricalOrders).toHaveBeenCalled();
  });

  it("get_historical_orders handles pagination cursors", async () => {
    const order = {
      id: "o",
      client_order_id: "co",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      quantity: "1",
      filled_quantity: "1",
      leaves_quantity: "0",
      status: "filled",
      time_in_force: "gtc",
      created_date: 1700000000000,
    };

    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [order],
      metadata: { timestamp: 1700000000000 },
    });

    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {
        start_date: "14d",
      },
    });

    const text = getText(result);
    expect(text).toContain("o");
    expect(mockClient.getHistoricalOrders).toHaveBeenCalled();
  });
});

describe("get_client_trades", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all trade fields", async () => {
    mockClient.getPrivateTrades.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          orderId: "d0184248-2de5-4b5a-9a1c-123456789abc",
          symbol: "BTC/USD",
          side: "buy",
          price: "95000",
          quantity: "0.001",
          maker: false,
          timestamp: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: { symbol: "BTC-USD" },
    });
    const text = getText(result);
    expect(text).toContain("Your trades for BTC-USD");
    expect(text).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(text).toContain("d0184248-2de5-4b5a-9a1c-123456789abc");
    expect(text).toContain("BTC/USD");
    expect(text).toContain("buy");
    expect(text).toContain("95000");
    expect(text).toContain("0.001");
    expect(text).toContain("false");
    expect(text).toContain("2023-11-14 22:13:20 UTC");
  });

  it("validates date formats", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: { symbol: "BTC-USD", start_date: "not-a-date" },
    });
    expect(getText(result)).toContain("Invalid date format");
  });

  it("fetches all pages automatically", async () => {
    const tradeA = {
      id: "trade-page1",
      orderId: "order-page1",
      symbol: "ETH/USD",
      side: "sell",
      price: "3000",
      quantity: "1",
      maker: true,
      timestamp: 1700000000000,
    };
    const tradeB = { ...tradeA, id: "trade-page2", orderId: "order-page2" };
    mockClient.getPrivateTrades.mockResolvedValue({
      data: [tradeA, tradeB],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: {
        symbol: "ETH-USD",
      },
    });
    const text = getText(result);
    expect(text).toContain("trade-page1");
    expect(text).toContain("trade-page2");
  });

  it("returns empty message when no trades", async () => {
    mockClient.getPrivateTrades.mockResolvedValue({
      data: [],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: { symbol: "BTC-USD" },
    });
    expect(getText(result)).toContain("No trade history found for BTC-USD");
  });

  it("handles long date ranges", async () => {
    const trade = {
      id: "trade-batch",
      orderId: "order-batch",
      symbol: "BTC/USD",
      side: "buy",
      price: "90000",
      quantity: "0.1",
      maker: false,
      timestamp: 1700000000000,
    };

    mockClient.getPrivateTrades.mockResolvedValue({
      data: [trade],
      metadata: { timestamp: 1700000000000 },
    });

    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: {
        symbol: "BTC-USD",
        start_date: "90d",
      },
    });

    const text = getText(result);
    expect(text).toContain("trade-batch");
    expect(mockClient.getPrivateTrades).toHaveBeenCalled();
  });

  it("handles pagination cursors", async () => {
    const trade = {
      id: "t",
      orderId: "o",
      symbol: "BTC/USD",
      side: "buy",
      price: "90000",
      quantity: "0.1",
      maker: false,
      timestamp: 1700000000000,
    };

    mockClient.getPrivateTrades.mockResolvedValue({
      data: [trade],
      metadata: { timestamp: 1700000000000 },
    });

    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: {
        symbol: "BTC-USD",
        start_date: "14d",
      },
    });

    const text = getText(result);
    expect(text).toContain("t");
    expect(mockClient.getPrivateTrades).toHaveBeenCalled();
  });
});

describe("get_order_by_id", () => {
  it("returns formatted limit order", async () => {
    mockClient.getOrder.mockResolvedValue({
      data: {
        id: "order-abc",
        client_order_id: "co-abc",
        symbol: "BTC-USD",
        side: "buy",
        type: "limit",
        price: "90000",
        quantity: "0.1",
        filled_quantity: "0",
        leaves_quantity: "0.1",
        status: "new",
        time_in_force: "gtc",
        execution_instructions: ["post_only"],
        created_date: 1700000000000,
        updated_date: 1700000001000,
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_by_id",
      arguments: { order_id: "order-abc" },
    });
    const text = getText(result);
    expect(text).toContain("order-abc");
    expect(text).toContain("BTC-USD");
    expect(text).toContain("Price: 90000");
    expect(text).toContain("post_only");
  });

  it("returns trigger details for conditional order", async () => {
    mockClient.getOrder.mockResolvedValue({
      data: {
        id: "order-cond",
        client_order_id: "co-cond",
        symbol: "ETH-USD",
        side: "sell",
        type: "conditional",
        price: "0",
        quantity: "1",
        filled_quantity: "0",
        leaves_quantity: "1",
        status: "new",
        time_in_force: "gtc",
        execution_instructions: [],
        conditional: {
          trigger_price: "3000",
          type: "market",
          trigger_direction: "le",
          time_in_force: "gtc",
          execution_instructions: [],
        },
        created_date: 1700000000000,
        updated_date: 1700000001000,
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_by_id",
      arguments: { order_id: "order-cond" },
    });
    const text = getText(result);
    expect(text).toContain("Conditional trigger");
    expect(text).toContain("3000");
    expect(text).toContain("<=");
  });

  it("returns trigger details for tpsl order", async () => {
    mockClient.getOrder.mockResolvedValue({
      data: {
        id: "order-tpsl",
        client_order_id: "co-tpsl",
        symbol: "BTC-USD",
        side: "sell",
        type: "tpsl",
        price: "0",
        quantity: "0.1",
        filled_quantity: "0",
        leaves_quantity: "0.1",
        status: "new",
        time_in_force: "gtc",
        execution_instructions: [],
        take_profit: {
          trigger_price: "100000",
          type: "market",
          trigger_direction: "ge",
          time_in_force: "gtc",
          execution_instructions: [],
        },
        stop_loss: {
          trigger_price: "80000",
          type: "market",
          trigger_direction: "le",
          time_in_force: "gtc",
          execution_instructions: [],
        },
        created_date: 1700000000000,
        updated_date: 1700000001000,
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_by_id",
      arguments: { order_id: "order-tpsl" },
    });
    const text = getText(result);
    expect(text).toContain("Take profit");
    expect(text).toContain("100000");
    expect(text).toContain(">=");
    expect(text).toContain("Stop loss");
    expect(text).toContain("80000");
  });

  it("returns auth error as setup guide", async () => {
    const { AuthNotConfiguredError } = await import("api-k9x2a");
    mockClient.getOrder.mockRejectedValue(new AuthNotConfiguredError());
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_by_id",
      arguments: { order_id: "order-abc" },
    });
    expect(getText(result)).toContain("Setup guide text");
  });
});

describe("get_order_fills", () => {
  it("returns all fill fields", async () => {
    mockClient.getOrderFills.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          orderId: "d0184248-2de5-4b5a-9a1c-123456789abc",
          symbol: "BTC/USD",
          side: "buy",
          price: "95000",
          quantity: "0.001",
          maker: false,
          timestamp: 1700000000000,
        },
      ],
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_fills",
      arguments: { order_id: "d0184248-2de5-4b5a-9a1c-123456789abc" },
    });
    const text = getText(result);
    expect(text).toContain(
      "Fills for order d0184248-2de5-4b5a-9a1c-123456789abc",
    );
    expect(text).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(text).toContain("BTC/USD");
    expect(text).toContain("buy");
    expect(text).toContain("95000");
    expect(text).toContain("0.001");
    expect(text).toContain("false");
    expect(text).toContain("2023-11-14 22:13:20 UTC");
  });

  it("returns empty message when no fills", async () => {
    mockClient.getOrderFills.mockResolvedValue({ data: [] });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_fills",
      arguments: { order_id: "d0184248-2de5-4b5a-9a1c-123456789abc" },
    });
    expect(getText(result)).toContain(
      "No fills found for order d0184248-2de5-4b5a-9a1c-123456789abc",
    );
  });
});
