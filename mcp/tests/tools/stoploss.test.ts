import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBacktestTools } from "../../src/tools/backtest.js";
import { vi, describe, beforeEach, it, expect } from "vitest";

// ── Mock candles — 5 flat hourly candles at 100k ──────────────────────────────
// Using flat candles (open=high=low=close=100k) means no trades fire during the
// backtest simulation itself; we're testing the validation guards only.

const MOCK_CANDLES = Array.from({ length: 5 }, (_, i) => ({
  start: 1_700_000_000_000 + i * 3_600_000,
  open: "100000",
  high: "100000",
  low: "100000",
  close: "100000",
  volume: "1",
}));

const mockClient = { getCandles: vi.fn() };

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "",
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
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
  return { ...actual, AuthNotConfiguredError, RateLimitError, ServerError };
});

// ── Client factory ────────────────────────────────────────────────────────────

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

// ── grid_backtest — stop-loss validation ──────────────────────────────────────
//
// Config: startPrice≈100k (from mock candles), grid_levels=3 per side (totalLevels=6),
//         range_pct="5" → rangeDec=0.05 → lowestLevel = 100k * 0.95 = 95k.
// Guard: SL must be strictly below lowestLevel (95k).
//   SL < 95k → valid (backtest runs)
//   SL ≥ 95k → error "must be strictly below the lowest grid level"

describe("grid_backtest — stop-loss validation", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCandles.mockResolvedValue({ data: MOCK_CANDLES });
    client = await createClient();
  });

  const BASE = {
    symbol: "BTC-USD",
    grid_levels: 3,
    range_pct: "5",
    investment: "1000",
    days: 1,
    resolution: "1h",
  };

  it("MCP-B1: SL=0 (disabled) → backtest runs, no validation error", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, stop_loss_price: 0 },
      }),
    );
    expect(text).not.toContain("must be strictly below");
    expect(text).toContain("Grid Backtest Results");
  });

  it("MCP-B2: SL=94_000 (< lowestLevel=95k) → valid, backtest runs", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, stop_loss_price: 94_000 },
      }),
    );
    expect(text).not.toContain("must be strictly below");
    expect(text).toContain("Grid Backtest Results");
  });

  it("MCP-B3: SL=95_000 (= lowestLevel) → error: must be strictly below", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, stop_loss_price: 95_000 },
      }),
    );
    expect(text).toContain("must be strictly below the lowest grid level");
  });

  it("MCP-B4: SL=97_000 (> lowestLevel, < startPrice) → error", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, stop_loss_price: 97_000 },
      }),
    );
    expect(text).toContain("must be strictly below the lowest grid level");
  });

  it("MCP-B5: SL=101_000 (> startPrice) → error", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_backtest",
        arguments: { ...BASE, stop_loss_price: 101_000 },
      }),
    );
    expect(text).toContain("must be strictly below the lowest grid level");
  });
});

// ── grid_optimize — stop-loss validation ──────────────────────────────────────
//
// Guard: SL must be strictly below startPrice (100k).
//   SL < 100k → valid (optimize runs)
//   SL ≥ 100k → error "must be below the backtest start price"

describe("grid_optimize — stop-loss validation", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCandles.mockResolvedValue({ data: MOCK_CANDLES });
    client = await createClient();
  });

  const BASE = {
    symbol: "BTC-USD",
    investment: "1000",
    days: 1,
    resolution: "1h",
    grid_levels_options: "3,5",
    range_pct_options: "5,10",
  };

  it("MCP-O1: SL=0 (disabled) → optimize runs, no validation error", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...BASE, stop_loss_price: 0 },
      }),
    );
    expect(text).not.toContain("must be below the backtest start price");
  });

  it("MCP-O2: SL=80_000 (< startPrice=100k) → valid, optimize runs", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...BASE, stop_loss_price: 80_000 },
      }),
    );
    expect(text).not.toContain("must be below the backtest start price");
  });

  it("MCP-O3: SL=100_000 (= startPrice) → error: must be below start price", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...BASE, stop_loss_price: 100_000 },
      }),
    );
    expect(text).toContain("must be below the backtest start price");
  });

  it("MCP-O4: SL=101_000 (> startPrice) → error", async () => {
    const text = getText(
      await client.callTool({
        name: "grid_optimize",
        arguments: { ...BASE, stop_loss_price: 101_000 },
      }),
    );
    expect(text).toContain("must be below the backtest start price");
  });
});
