import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import type { Ticker, Candle } from "api-k9x2a";

const mockGetTickers = vi.fn();
const mockGetCandles = vi.fn();
const mockGetOrderBook = vi.fn();

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    RevolutXClient: vi.fn().mockImplementation(() => ({
      isAuthenticated: true,
      getTickers: mockGetTickers,
      getCandles: mockGetCandles,
      getOrderBook: mockGetOrderBook,
    })),
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
  };
});

const mockSendWithRetries = vi.fn();
vi.mock("../src/engine/notify.js", () => ({
  sendWithRetries: (...args: unknown[]) => mockSendWithRetries(...args),
  formatNotification: (
    _type: string,
    pair: string,
    price: unknown,
    result: unknown,
  ) => `Alert: ${pair} at ${price} - ${(result as { detail: string }).detail}`,
}));

import {
  ForegroundMonitor,
  type MonitorSpec,
  type TickResult,
} from "../src/engine/monitor.js";
import type { TelegramConnection } from "../src/db/store.js";

const CONN: TelegramConnection = {
  id: "conn-1",
  label: "test",
  bot_token: "tok",
  chat_id: "123",
  enabled: true,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

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
    mockSendWithRetries.mockResolvedValue({ success: true });
  });

  it("reports price and not-triggered when condition not met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const result = await runSingleTick(mon);

    expect(result.price?.toString()).toBe("95000");
    expect(result.evalResult?.conditionMet).toBe(false);
    expect(result.triggered).toBe(false);
    expect(result.notified).toBe(false);
  });

  it("triggers and notifies when condition met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const result = await runSingleTick(mon);

    expect(result.evalResult?.conditionMet).toBe(true);
    expect(result.triggered).toBe(true);
    expect(result.notified).toBe(true);
    expect(mockSendWithRetries).toHaveBeenCalledOnce();
    expect(mockSendWithRetries).toHaveBeenCalledWith(
      "tok",
      "123",
      expect.any(String),
    );
  });

  it("does not re-notify on consecutive conditions met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    const r1 = await runSingleTick(mon);
    expect(r1.triggered).toBe(true);

    const r2 = await runSingleTick(mon);
    expect(r2.triggered).toBe(true);
    expect(r2.notified).toBe(false);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(1);
  });

  it("re-notifies after condition resets", async () => {
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const r1 = await runSingleTick(mon);
    expect(r1.triggered).toBe(true);
    expect(r1.notified).toBe(true);

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const r2 = await runSingleTick(mon);
    expect(r2.evalResult?.conditionMet).toBe(false);
    expect(r2.triggered).toBe(false);

    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "110000"));
    const r3 = await runSingleTick(mon);
    expect(r3.triggered).toBe(true);
    expect(r3.notified).toBe(true);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(2);
  });

  it("does not send notifications when no connections", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), []);
    const result = await runSingleTick(mon);

    expect(result.triggered).toBe(true);
    expect(result.notified).toBe(false);
    expect(mockSendWithRetries).not.toHaveBeenCalled();
  });

  it("returns error when ticker fetch fails", async () => {
    mockGetTickers.mockRejectedValue(new Error("Network error"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const result = await runSingleTick(mon);

    expect(result.error).toContain("Failed to fetch ticker");
    expect(result.error).toContain("Network error");
  });

  it("returns error when no price data", async () => {
    mockGetTickers.mockResolvedValue({ data: [] });
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const result = await runSingleTick(mon);

    expect(result.error).toBe("No price data for BTC-USD");
  });

  it("sends to multiple connections", async () => {
    const conn2: TelegramConnection = {
      ...CONN,
      id: "conn-2",
      bot_token: "tok2",
      chat_id: "456",
    };
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN, conn2]);
    const result = await runSingleTick(mon);

    expect(result.notified).toBe(true);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(2);
    expect(mockSendWithRetries).toHaveBeenCalledWith(
      "tok",
      "123",
      expect.any(String),
    );
    expect(mockSendWithRetries).toHaveBeenCalledWith(
      "tok2",
      "456",
      expect.any(String),
    );
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
    const { RevolutXClient } = await import("api-k9x2a");
    internals._client = new RevolutXClient();
  }

  const result = await internals._runTick();
  internals._printTick(result);
  spy.mockRestore();
  return result;
}
