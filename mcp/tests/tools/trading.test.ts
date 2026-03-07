import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTradingTools } from "../../src/tools/trading.js";

const mockClient = {
  getActiveOrders: vi.fn(),
  getPrivateTrades: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("revolutx-api", async () => {
  class AuthNotConfiguredError extends Error {
    name = "AuthNotConfiguredError";
  }
  return { AuthNotConfiguredError };
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

function getText(result: any): string {
  return result.content[0].text ?? "";
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
});
