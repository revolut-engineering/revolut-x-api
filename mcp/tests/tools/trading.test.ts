import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTradingTools } from "../../src/tools/trading.js";

const mockClient = {
  getActiveOrders: vi.fn(),
  getHistoricalOrders: vi.fn(),
  getPrivateTrades: vi.fn(),
  getOrderFills: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("revolutx-api", async () => {
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
  return { AuthNotConfiguredError, RateLimitError, ServerError };
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

describe("order_command", () => {
  it("place_market generates correct CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_market",
        symbol: "BTC-USD",
        side: "buy",
        size: "0.001",
      },
    });
    const text = getText(result);
    expect(text).toContain("Place a market buy order");
    expect(text).toContain("revx order place BTC-USD buy 0.001 --market");
  });

  it("place_market with quote_size", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_market",
        symbol: "BTC-USD",
        side: "buy",
        quote_size: "1000",
      },
    });
    const text = getText(result);
    expect(text).toContain("--market");
    expect(text).toContain("--quote-size 1000");
  });

  it("place_market validates symbol", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_market",
        symbol: "bad",
        side: "buy",
        size: "0.1",
      },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });

  it("place_market validates side", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_market",
        symbol: "BTC-USD",
        side: "hold",
        size: "0.1",
      },
    });
    expect(getText(result)).toContain("Invalid side");
  });

  it("place_market rejects both sizes", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_market",
        symbol: "BTC-USD",
        side: "buy",
        size: "0.1",
        quote_size: "1000",
      },
    });
    expect(getText(result)).toContain("either size or quote_size, not both");
  });

  it("place_market requires at least one size", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "place_market", symbol: "BTC-USD", side: "buy" },
    });
    expect(getText(result)).toContain("either size or quote_size");
  });

  it("place_market requires symbol", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "place_market", side: "buy", size: "0.1" },
    });
    expect(getText(result)).toContain("Missing required parameter: symbol");
  });

  it("place_limit generates correct CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_limit",
        symbol: "BTC-USD",
        side: "sell",
        size: "0.1",
        price: "100000",
      },
    });
    const text = getText(result);
    expect(text).toContain("Place a limit sell order");
    expect(text).toContain("revx order place BTC-USD sell 0.1 --limit 100000");
  });

  it("place_limit with post_only", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_limit",
        symbol: "ETH-EUR",
        side: "buy",
        size: "1",
        price: "3000",
        post_only: true,
      },
    });
    const text = getText(result);
    expect(text).toContain("--limit 3000");
    expect(text).toContain("--post-only");
  });

  it("place_limit requires price", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: {
        action: "place_limit",
        symbol: "BTC-USD",
        side: "buy",
        size: "0.1",
      },
    });
    expect(getText(result)).toContain("Missing required parameter: price");
  });

  it("cancel generates correct CLI command", async () => {
    const client = await createClient();
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "cancel", venue_order_id: uuid },
    });
    const text = getText(result);
    expect(text).toContain(`Cancel order ${uuid}`);
    expect(text).toContain(`revx order cancel ${uuid}`);
  });

  it("cancel validates UUID format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "cancel", venue_order_id: "not-a-uuid" },
    });
    expect(getText(result)).toContain("Invalid order ID format");
  });

  it("cancel requires venue_order_id", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "cancel" },
    });
    expect(getText(result)).toContain(
      "Missing required parameter: venue_order_id",
    );
  });

  it("cancel_all generates correct CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "order_command",
      arguments: { action: "cancel_all" },
    });
    const text = getText(result);
    expect(text).toContain("Cancel all open orders");
    expect(text).toContain("revx order cancel-all");
  });
});

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
          status: "ACTIVE",
          time_in_force: "GTC",
          created_date: "2024-01-01",
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
    const { AuthNotConfiguredError } = await import("revolutx-api");
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
      arguments: { symbol: "bad" },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });

  it("get_historical_orders passes symbol and date filters", async () => {
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    await client.callTool({
      name: "get_historical_orders",
      arguments: {
        symbol: "ETH-EUR",
        start_date: 1700000000000,
        end_date: 1700086400000,
        limit: 10,
      },
    });
    expect(mockClient.getHistoricalOrders).toHaveBeenCalledWith({
      symbols: ["ETH-EUR"],
      startDate: 1700000000000,
      endDate: 1700086400000,
      limit: 10,
    });
  });

  it("get_historical_orders shows cursor when more results available", async () => {
    mockClient.getHistoricalOrders.mockResolvedValue({
      data: [
        {
          id: "hist-2",
          client_order_id: "co-hist-2",
          symbol: "ETH-USD",
          side: "sell",
          type: "market",
          quantity: "1",
          filled_quantity: "1",
          leaves_quantity: "0",
          status: "filled",
          time_in_force: "IOC",
          created_date: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000, next_cursor: "abc123" },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_historical_orders",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("More orders available (cursor: abc123)");
  });
});

describe("get_client_trades", () => {
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
    expect(text).toContain("2023-11-14T");
  });

  it("shows cursor when more trades available", async () => {
    mockClient.getPrivateTrades.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          orderId: "d0184248-2de5-4b5a-9a1c-123456789abc",
          symbol: "ETH/USD",
          side: "sell",
          price: "3000",
          quantity: "1",
          maker: true,
          timestamp: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000, next_cursor: "xyz789" },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_client_trades",
      arguments: { symbol: "ETH-USD" },
    });
    expect(getText(result)).toContain("More trades available (cursor: xyz789)");
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
    expect(text).toContain("2023-11-14T");
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
