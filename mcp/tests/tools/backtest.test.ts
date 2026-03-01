/**
 * Tests for backtest tools — grid_backtest, grid_optimize.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBacktestTools } from "../../src/tools/backtest.js";

const mockGetCandles = vi.fn();

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => ({
    getCandles: mockGetCandles,
  })),
}));

vi.mock("../../src/shared/client/exceptions.js", async () => {
  class AuthNotConfiguredError extends Error { name = "AuthNotConfiguredError"; }
  return { AuthNotConfiguredError };
});

vi.mock("../../src/shared/auth/credentials.js", () => ({
  SETUP_GUIDE: "Setup guide text",
}));

const CANDLES = [
  { start: 1, open: "100", high: "110", low: "90", close: "105" },
  { start: 2, open: "105", high: "115", low: "95", close: "100" },
  { start: 3, open: "100", high: "108", low: "92", close: "106" },
  { start: 4, open: "106", high: "112", low: "98", close: "103" },
  { start: 5, open: "103", high: "109", low: "94", close: "107" },
];

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerBacktestTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("backtest tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grid_backtest validates symbol", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "grid_backtest",
      arguments: { symbol: "bad" },
    });
    expect(getText(result)).toContain("Invalid symbol format");
  });

  it("grid_backtest validates grid_levels range", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "grid_backtest",
      arguments: { symbol: "BTC-USD", grid_levels: 2 },
    });
    expect(getText(result)).toContain("grid_levels must be between 3 and 50");
  });

  it("grid_backtest returns formatted results", async () => {
    mockGetCandles.mockResolvedValue(CANDLES);
    const client = await createClient();
    const result = await client.callTool({
      name: "grid_backtest",
      arguments: { symbol: "BTC-USD", grid_levels: 5, range_pct: "10" },
    });
    const text = getText(result);
    expect(text).toContain("Grid Backtest Results for BTC-USD");
    expect(text).toContain("Performance");
    expect(text).toContain("Total trades:");
  });

  it("grid_optimize rejects too many combinations", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "grid_optimize",
      arguments: {
        symbol: "BTC-USD",
        grid_levels_options: Array.from({ length: 21 }, (_, i) => i + 3).join(","),
        range_pct_options: Array.from({ length: 11 }, (_, i) => i + 1).join(","),
      },
    });
    expect(getText(result)).toContain("Too many combinations");
  });

  it("grid_optimize returns ranked results", async () => {
    mockGetCandles.mockResolvedValue(CANDLES);
    const client = await createClient();
    const result = await client.callTool({
      name: "grid_optimize",
      arguments: {
        symbol: "BTC-USD",
        grid_levels_options: "5,10",
        range_pct_options: "5,10",
      },
    });
    const text = getText(result);
    expect(text).toContain("Grid Optimization Results for BTC-USD");
    expect(text).toContain("Best by Metric:");
  });
});
