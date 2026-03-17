import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import type { Ticker, Candle } from "revolutx-api";

const mockGetTickers = vi.fn();
const mockGetCandles = vi.fn();
const mockGetOrderBook = vi.fn();

vi.mock("revolutx-api", () => ({
  RevolutXClient: vi.fn().mockImplementation(() => ({
    isAuthenticated: true,
    getTickers: mockGetTickers,
    getCandles: mockGetCandles,
    getOrderBook: mockGetOrderBook,
  })),
  getConfigDir: () => "/tmp/revx-test",
  ensureConfigDir: () => {},
}));

import {
  ForegroundMonitor,
  type MonitorSpec,
  type TickResult,
} from "../src/engine/monitor.js";

function makeSpec(overrides?: Partial<MonitorSpec>): MonitorSpec {
  return {
    pair: "BTC-USD",
    alertType: "price",
    config: { direction: "above", threshold: "100000" },
    intervalSec: 10,
    ...overrides,
  };
}

function tickerResponse(symbol: string, mid: string) {
  return {
    data: [{ symbol, mid, bid: mid, ask: mid, last_price: mid }],
  };
}

describe("ForegroundMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports price and not-triggered when condition not met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const mon = new ForegroundMonitor(makeSpec());
    const result = await runSingleTick(mon);

    expect(result.price?.toString()).toBe("95000");
    expect(result.evalResult?.conditionMet).toBe(false);
    expect(result.triggered).toBe(false);
  });

  it("triggers when condition met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec());
    const result = await runSingleTick(mon);

    expect(result.evalResult?.conditionMet).toBe(true);
    expect(result.triggered).toBe(true);
  });

  it("does not re-trigger on consecutive conditions met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec());

    const r1 = await runSingleTick(mon);
    expect(r1.triggered).toBe(true);

    const r2 = await runSingleTick(mon);
    expect(r2.triggered).toBe(true);
  });

  it("re-triggers after condition resets", async () => {
    const mon = new ForegroundMonitor(makeSpec());

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const r1 = await runSingleTick(mon);
    expect(r1.triggered).toBe(true);

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const r2 = await runSingleTick(mon);
    expect(r2.evalResult?.conditionMet).toBe(false);
    expect(r2.triggered).toBe(false);

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "110000"));
    const r3 = await runSingleTick(mon);
    expect(r3.triggered).toBe(true);
  });

  it("returns error when ticker fetch fails", async () => {
    mockGetTickers.mockRejectedValue(new Error("Network error"));
    const mon = new ForegroundMonitor(makeSpec());
    const result = await runSingleTick(mon);

    expect(result.error).toContain("Failed to fetch ticker");
    expect(result.error).toContain("Network error");
  });

  it("returns error when no price data", async () => {
    mockGetTickers.mockResolvedValue({ data: [] });
    const mon = new ForegroundMonitor(makeSpec());
    const result = await runSingleTick(mon);

    expect(result.error).toBe("No price data for BTC-USD");
  });
});

describe("ForegroundMonitor.buildMaps", () => {
  it("parses ticker data into price and ticker maps", () => {
    const tickers = [
      {
        symbol: "BTC-USD",
        mid: "100000",
        bid: "99990",
        ask: "100010",
        last_price: "99999",
      },
      {
        symbol: "ETH-USD",
        mid: null,
        bid: null,
        ask: null,
        last_price: "3500",
      },
    ];
    const [priceMap, tickerMap] = ForegroundMonitor.buildMaps(
      tickers as unknown as Ticker[],
    );

    expect(priceMap.get("BTC-USD")?.toString()).toBe("100000");
    expect(tickerMap.get("BTC-USD")?.bid?.toString()).toBe("99990");
    expect(tickerMap.get("BTC-USD")?.ask?.toString()).toBe("100010");
    expect(priceMap.get("ETH-USD")?.toString()).toBe("3500");
  });

  it("normalizes slash-separated symbols", () => {
    const tickers = [
      {
        symbol: "BTC/USD",
        mid: "100000",
        bid: null,
        ask: null,
        last_price: "100000",
      },
    ];
    const [priceMap] = ForegroundMonitor.buildMaps(
      tickers as unknown as Ticker[],
    );

    expect(priceMap.get("BTC/USD")?.toString()).toBe("100000");
    expect(priceMap.get("BTC-USD")?.toString()).toBe("100000");
  });

  it("skips tickers with invalid price", () => {
    const tickers = [
      {
        symbol: "BAD",
        mid: "not-a-number",
        bid: null,
        ask: null,
        last_price: "also-bad",
      },
    ];
    const [priceMap] = ForegroundMonitor.buildMaps(
      tickers as unknown as Ticker[],
    );
    expect(priceMap.size).toBe(0);
  });
});

describe("ForegroundMonitor.parseCandles", () => {
  it("parses and sorts candles by timestamp", () => {
    const candles = [
      {
        start: 200,
        open: "10",
        high: "12",
        low: "9",
        close: "11",
        volume: "100",
      },
      {
        start: 100,
        open: "9",
        high: "11",
        low: "8",
        close: "10",
        volume: "50",
      },
    ];
    const parsed = ForegroundMonitor.parseCandles(
      candles as unknown as Candle[],
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].timestamp).toBe(100);
    expect(parsed[1].timestamp).toBe(200);
    expect((parsed[0].close as Decimal).toString()).toBe("10");
  });

  it("skips candles with invalid numbers", () => {
    const candles = [
      {
        start: 100,
        open: "bad",
        high: "12",
        low: "9",
        close: "11",
        volume: "100",
      },
      {
        start: 200,
        open: "10",
        high: "12",
        low: "9",
        close: "11",
        volume: "100",
      },
    ];
    const parsed = ForegroundMonitor.parseCandles(
      candles as unknown as Candle[],
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].timestamp).toBe(200);
  });
});

async function runSingleTick(mon: ForegroundMonitor): Promise<TickResult> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const internals = mon as unknown as {
    _client: unknown;
    _runTick: () => Promise<TickResult>;
    _printTick: (result: TickResult) => void;
  };

  if (!internals._client) {
    const { RevolutXClient } = await import("revolutx-api");
    internals._client = new RevolutXClient();
  }

  const result = await internals._runTick();
  internals._printTick(result);
  spy.mockRestore();
  return result;
}
