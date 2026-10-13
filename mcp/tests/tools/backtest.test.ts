import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBacktestTools } from "../../src/tools/backtest.js";
import { vi, describe, beforeEach, it, expect } from "vitest";
import { RateLimitError } from "@revolut/revolut-x-api";

const MOCK_CANDLES = Array.from({ length: 5 }, (_, i) => ({
  start: 1_700_000_000_000 + i * 3_600_000,
  open: "100000",
  high: "100000",
  low: "100000",
  close: "100000",
  volume: "1",
}));

const BTC_USD = {
  base: "BTC",
  quote: "USD",
  base_step: "0.00001",
  quote_step: "0.01",
  min_order_size: "0.00001",
  max_order_size: "10",
  min_order_size_quote: "1",
  status: "active",
};

const mockClient = { getCandles: vi.fn(), getCurrencyPairs: vi.fn() };

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "",
}));

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerBacktestTools(server);
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

const BASE = {
  symbol: "BTC-USD",
  grid_levels: 3,
  range_pct: "5",
  investment: "1000",
  days: 1,
  resolution: "1h",
};

describe("grid_backtest — pair limits and sizing", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCandles.mockResolvedValue({ data: MOCK_CANDLES });
    mockClient.getCurrencyPairs.mockResolvedValue({ "BTC/USD": BTC_USD });
    client = await createClient();
  });

  it("refuses a grid whose orders fall below the pair's minimum order size", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC/USD": { ...BTC_USD, min_order_size_quote: "500" },
    });

    const text = getText(
      await client.callTool({ name: "grid_backtest", arguments: BASE }),
    );

    expect(text).toMatch(/below the minimum/);
    expect(text).not.toContain("Grid Backtest Results");
  });

  it("refuses a grid below the pair minimum before fetching candles", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC/USD": { ...BTC_USD, min_order_size_quote: "500" },
    });

    const result = await client.callTool({
      name: "grid_backtest",
      arguments: BASE,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(
      "Quote per level 333.33 is below the minimum quote order size 500.",
    );
    expect(mockClient.getCandles).not.toHaveBeenCalled();
  });

  it("refuses an optimization with any level count below the pair minimum before fetching candles", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC/USD": { ...BTC_USD, min_order_size_quote: "500" },
    });

    const result = await client.callTool({
      name: "grid_optimize",
      arguments: {
        symbol: "BTC-USD",
        grid_levels_options: "1,3",
        range_pct_options: "5",
        investment: "1000",
        days: 1,
        resolution: "1h",
      },
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(
      "Quote per level 333.33 is below the minimum quote order size 500.",
    );
    expect(mockClient.getCandles).not.toHaveBeenCalled();
  });

  it("gives the annualized return for a year of candles", async () => {
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now() - 365 * day;
    mockClient.getCandles.mockResolvedValue({
      data: Array.from({ length: 365 }, (_, i) => ({
        ...MOCK_CANDLES[0],
        start: start + i * day,
      })),
    });

    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, days: 365, resolution: "1d" },
      }),
    );

    expect(text).toMatch(/Annualized return: -?\d+\.\d{2}%/);
  });

  it("gives no annualized return for less than a year of candles", async () => {
    const text = getText(
      await client.callTool({ name: "grid_backtest", arguments: BASE }),
    );

    expect(text).toContain(
      "Annualized return: not shown, needs a year of data",
    );
  });

  it("returns an error when the pair is not listed", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({});

    const text = getText(
      await client.callTool({ name: "grid_backtest", arguments: BASE }),
    );

    expect(text).toContain("Pair configuration not found for BTC-USD");
  });

  it("accepts up to 100 levels per side", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: {
          ...BASE,
          grid_levels: 100,
          range_pct: "20",
          investment: "100000",
        },
      }),
    );

    expect(text).toContain("Grid levels: 100 per side");
  });

  it("rejects a level count that isn't a whole number", async () => {
    const result = await client.callTool({
      name: "grid_backtest",
      arguments: { ...BASE, grid_levels: 2.5 },
    });

    expect(getText(result)).toContain(
      "grid_levels must be a whole number between 1 and 100 (per side), got 2.5.",
    );
    expect(result.isError).toBe(true);
  });

  it("shows results for a split grid whose market buy only fits after the fee", async () => {
    mockClient.getCurrencyPairs.mockResolvedValue({
      "BTC/USD": { ...BTC_USD, max_order_size: "0.02997" },
    });

    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, investment: "6000", split_investment: true },
      }),
    );

    expect(text).toContain("Grid Backtest Results");
  });

  it("reports a rate limit on the pair lookup like other calls", async () => {
    mockClient.getCurrencyPairs.mockRejectedValue(
      new RateLimitError("Rate limit exceeded", 500),
    );

    const text = getText(
      await client.callTool({ name: "grid_backtest", arguments: BASE }),
    );

    expect(text).toBe("Rate limit exceeded. Retry after 500ms.");
  });

  it("shows the per-level amount the simulation actually uses", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, split_investment: true },
      }),
    );

    expect(text).toContain("USD/level: $166.66");
  });

  it("reports the trailing-up and stop-loss status", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, trailing_up: true, stop_loss_price: 90_000 },
      }),
    );

    expect(text).toContain("Trailing up: 0 shifts");
    expect(text).toContain("Stop-loss ($90,000.00): not triggered");
  });

  it("describes trailing up at the second level above the grid", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "grid_backtest");
    const trailing = (
      tool?.inputSchema.properties as Record<string, { description?: string }>
    ).trailing_up;

    expect(trailing.description).toContain(
      "second grid level above the upper boundary",
    );
    expect(trailing.description).toContain("once the grid holds no coins");
  });
});

describe("grid_optimize — pair limits", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCandles.mockResolvedValue({ data: MOCK_CANDLES });
    mockClient.getCurrencyPairs.mockResolvedValue({ "BTC/USD": BTC_USD });
    client = await createClient();
  });

  const OPTIMIZE = {
    symbol: "BTC-USD",
    investment: "1000",
    days: 1,
    resolution: "1h",
    grid_levels_options: "3,5",
    range_pct_options: "3,20",
  };

  it("fails when the stop-loss sits inside any tested grid", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...OPTIMIZE, stop_loss_price: 90_000 },
      }),
    );

    expect(text).toMatch(/[Ss]top-loss/);
    expect(text).not.toContain("Grid Optimization Results");
  });

  it("rejects level options written in other number formats before fetching candles", async () => {
    const texts = [];
    for (const options of ["1e1", "0x10", ""]) {
      texts.push(
        getText(
          await client.callTool({
            name: "grid_optimize",
            arguments: { ...OPTIMIZE, grid_levels_options: options },
          }),
        ),
      );
    }

    for (const text of texts) {
      expect(text).toContain(
        "grid_levels_options must be comma-separated whole numbers between 1 and 100 (per side).",
      );
    }
    expect(mockClient.getCandles).not.toHaveBeenCalled();
  });

  it("accepts up to 100 levels per side and rejects fractions", async () => {
    const accepted = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: {
          ...OPTIMIZE,
          investment: "100000",
          grid_levels_options: "100",
        },
      }),
    );
    const rejected = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...OPTIMIZE, grid_levels_options: "2.5" },
      }),
    );

    expect(accepted).toContain("Grid Optimization Results");
    expect(rejected).toContain(
      "grid_levels_options must be comma-separated whole numbers between 1 and 100 (per side).",
    );
  });
});
