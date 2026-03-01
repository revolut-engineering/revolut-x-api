/**
 * Tests for trading tools — 5 tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTradingTools } from "../../src/tools/trading.js";

const mockClient = {
  placeOrder: vi.fn(),
  getActiveOrders: vi.fn(),
  cancelOrder: vi.fn(),
  getClientTrades: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
}));

vi.mock("../../src/shared/client/exceptions.js", async () => {
  class AuthNotConfiguredError extends Error { name = "AuthNotConfiguredError"; }
  return { AuthNotConfiguredError };
});

vi.mock("../../src/shared/auth/credentials.js", () => ({
  SETUP_GUIDE: "Setup guide text",
}));

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTradingTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("trading tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("place_market_order validates symbol", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "place_market_order",
      arguments: { symbol: "bad", side: "buy", base_size: "0.1" },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });

  it("place_market_order validates side", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "place_market_order",
      arguments: { symbol: "BTC-USD", side: "hold", base_size: "0.1" },
    });
    expect(getText(result)).toContain("Invalid side");
  });

  it("place_market_order rejects both sizes", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "place_market_order",
      arguments: { symbol: "BTC-USD", side: "buy", base_size: "0.1", quote_size: "1000" },
    });
    expect(getText(result)).toContain("either base_size or quote_size, not both");
  });

  it("place_market_order succeeds", async () => {
    mockClient.placeOrder.mockResolvedValue({
      venue_order_id: "abc-123",
      client_order_id: "xxx",
      state: "ACTIVE",
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "place_market_order",
      arguments: { symbol: "BTC-USD", side: "buy", base_size: "0.1" },
    });
    const text = getText(result);
    expect(text).toContain("Market buy order placed");
    expect(text).toContain("abc-123");
  });

  it("place_limit_order succeeds", async () => {
    mockClient.placeOrder.mockResolvedValue({
      venue_order_id: "def-456",
      state: "PENDING",
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "place_limit_order",
      arguments: { symbol: "BTC-USD", side: "sell", price: "100000", base_size: "0.1" },
    });
    const text = getText(result);
    expect(text).toContain("Limit sell order placed");
    expect(text).toContain("def-456");
  });

  it("get_active_orders returns formatted list", async () => {
    mockClient.getActiveOrders.mockResolvedValue([
      {
        id: "order-1", client_order_id: "co-1", symbol: "BTC-USD",
        side: "buy", type: "limit", price: "90000", quantity: "0.1",
        filled_quantity: "0", leaves_quantity: "0.1",
        status: "ACTIVE", time_in_force: "GTC", created_date: "2024-01-01",
      },
    ]);
    const client = await createClient();
    const result = await client.callTool({ name: "get_active_orders", arguments: {} });
    const text = getText(result);
    expect(text).toContain("order-1");
    expect(text).toContain("90000");
  });

  it("cancel_order validates UUID format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "cancel_order",
      arguments: { venue_order_id: "not-a-uuid" },
    });
    expect(getText(result)).toContain("Invalid order ID format");
  });

  it("cancel_order succeeds with valid UUID", async () => {
    mockClient.cancelOrder.mockResolvedValue({});
    const client = await createClient();
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const result = await client.callTool({
      name: "cancel_order",
      arguments: { venue_order_id: uuid },
    });
    expect(getText(result)).toContain(`Order ${uuid} has been cancelled`);
  });
});
