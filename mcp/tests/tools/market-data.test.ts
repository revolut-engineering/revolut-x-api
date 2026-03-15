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
    expect(text).toContain("BTC");
    expect(text).toContain("Bitcoin");
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

  it("get_currency_pairs returns formatted table", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC-USD": {
        min_order_size: "0.001",
        max_order_size: "10",
        base_step: "0.00001",
        status: "active",
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_currency_pairs",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("BTC-USD");
    expect(text).toContain("0.001");
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
        asks: [{ p: "100000", pc: "USD", q: "0.5", qc: "BTC", no: "3" }],
        bids: [{ p: "99000", pc: "USD", q: "1.0", qc: "BTC", no: "5" }],
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
  });
});
