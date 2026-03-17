import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMarketDataTools } from "../../src/tools/market-data.js";

const mockClient = {
  getCurrencies: vi.fn(),
  getCurrencyPairs: vi.fn(),
  getOrderBook: vi.fn(),
  getTickers: vi.fn(),
  getCandles: vi.fn(),
  getAllTrades: vi.fn(),
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
  registerMarketDataTools(server);
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

describe("market data tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("get_currencies returns formatted table", async () => {
    mockClient.getCurrencies.mockResolvedValue({
      BTC: {
        name: "Bitcoin",
        asset_type: "crypto",
        scale: "8",
        status: "active",
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_currencies",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Symbol: BTC");
    expect(text).toContain("Name: Bitcoin");
    expect(text).toContain("Type: crypto");
    expect(text).toContain("Scale: 8");
    expect(text).toContain("Status: active");
  });

  it("get_currencies returns setup guide on auth error", async () => {
    const { AuthNotConfiguredError } = await import("revolutx-api");
    mockClient.getCurrencies.mockRejectedValue(
      new AuthNotConfiguredError("no auth"),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "get_currencies",
      arguments: {},
    });
    expect(getText(result)).toContain("Setup guide text");
  });

  it("get_currency_pairs returns all fields", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC-USD": {
        base: "BTC",
        quote: "USD",
        base_step: "0.00001",
        quote_step: "0.01",
        min_order_size: "0.001",
        max_order_size: "10",
        min_order_size_quote: "10",
        status: "active",
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_currency_pairs",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Pair: BTC-USD");
    expect(text).toContain("Base: BTC");
    expect(text).toContain("Quote: USD");
    expect(text).toContain("Base Step: 0.00001");
    expect(text).toContain("Quote Step: 0.01");
    expect(text).toContain("Min Order Size: 0.001");
    expect(text).toContain("Max Order Size: 10");
    expect(text).toContain("Min Order Size (Quote): 10");
    expect(text).toContain("Status: active");
  });

  it("get_order_book validates symbol format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_book",
      arguments: { symbol: "invalid" },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });

  it("get_order_book returns formatted data", async () => {
    mockClient.getOrderBook.mockResolvedValue({
      data: {
        asks: [{ price: "100000", quantity: "0.5", orderCount: 3 }],
        bids: [{ price: "99000", quantity: "1.0", orderCount: 5 }],
      },
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_order_book",
      arguments: { symbol: "BTC-USD" },
    });
    const text = getText(result);
    expect(text).toContain("ASKS (Sell)");
    expect(text).toContain("BIDS (Buy)");
    expect(text).toContain("100000");
    expect(text).toContain("0.5");
    expect(text).toContain("99000");
    expect(text).toContain("1.0");
  });

  it("get_tickers returns formatted data", async () => {
    mockClient.getTickers.mockResolvedValue({
      data: [
        {
          symbol: "BTC-USD",
          bid: "99000",
          ask: "100000",
          mid: "99500",
          last_price: "99800",
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_tickers",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("BTC-USD");
    expect(text).toContain("99000");
  });

  it("get_tickers passes symbols filter", async () => {
    mockClient.getTickers.mockResolvedValue({
      data: [
        {
          symbol: "BTC-USD",
          bid: "99000",
          ask: "100000",
          mid: "99500",
          last_price: "99800",
        },
        {
          symbol: "ETH-USD",
          bid: "2900",
          ask: "3000",
          mid: "2950",
          last_price: "2980",
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    await client.callTool({
      name: "get_tickers",
      arguments: { symbols: ["BTC-USD", "ETH-USD"] },
    });
    expect(mockClient.getTickers).toHaveBeenCalledWith({
      symbols: ["BTC-USD", "ETH-USD"],
    });
  });

  it("get_candles validates resolution", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_candles",
      arguments: { symbol: "BTC-USD", resolution: "2h" },
    });
    expect(getText(result)).toContain("Invalid resolution");
  });

  it("get_candles returns formatted data", async () => {
    mockClient.getCandles.mockResolvedValue({
      data: [
        {
          start: "2024-01-01T00:00",
          open: "90000",
          high: "91000",
          low: "89000",
          close: "90500",
          volume: "100",
        },
      ],
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_candles",
      arguments: { symbol: "BTC-USD" },
    });
    const text = getText(result);
    expect(text).toContain("BTC-USD");
    expect(text).toContain("90000");
    expect(text).toContain("1 total");
  });

  it("get_candles fetches multiple chunks for date range", async () => {
    mockClient.getCandles
      .mockResolvedValueOnce({
        data: [
          {
            start: "2024-01-01T00:00",
            open: "90000",
            high: "91000",
            low: "89000",
            close: "90500",
            volume: "100",
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            start: "2024-02-10T00:00",
            open: "95000",
            high: "96000",
            low: "94000",
            close: "95500",
            volume: "200",
          },
        ],
      });
    const client = await createClient();
    // 1h resolution: chunk = 1000 * 60min * 60s * 1000ms = 3_600_000_000ms (~41.6 days)
    // Two chunks: start to start+chunk, start+chunk to end
    const start = 1700000000000;
    // 1h chunk = 1000 candles * 3600s * 1000ms = 3_600_000_000ms; two chunks exactly
    const end = start + 2 * 1000 * 3600 * 1000;
    const result = await client.callTool({
      name: "get_candles",
      arguments: {
        symbol: "BTC-USD",
        resolution: "1h",
        start_date: start,
        end_date: end,
      },
    });
    const text = getText(result);
    expect(mockClient.getCandles).toHaveBeenCalledTimes(2);
    expect(text).toContain("2 total");
    expect(text).toContain("90000");
    expect(text).toContain("95000");
  });

  it("get_all_trades returns formatted list", async () => {
    mockClient.getAllTrades.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          symbol: "BTC/USD",
          price: "100000",
          quantity: "0.5",
          timestamp: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000 },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_all_trades",
      arguments: { symbol: "BTC-USD" },
    });
    const text = getText(result);
    expect(text).toContain("Public trades for BTC-USD");
    expect(text).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(text).toContain("BTC/USD");
    expect(text).toContain("100000");
    expect(text).toContain("0.5");
    expect(text).toContain("2023-11-14T");
  });

  it("get_all_trades shows cursor when more available", async () => {
    mockClient.getAllTrades.mockResolvedValue({
      data: [
        {
          id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          symbol: "ETH/USD",
          price: "3000",
          quantity: "1",
          timestamp: 1700000000000,
        },
      ],
      metadata: { timestamp: 1700000000000, next_cursor: "xyz789" },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_all_trades",
      arguments: { symbol: "ETH-USD" },
    });
    expect(getText(result)).toContain("More trades are available");
  });

  it("get_all_trades validates symbol format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_all_trades",
      arguments: { symbol: "invalid" },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });
});
