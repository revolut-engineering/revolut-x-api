import { stripVTControlCharacters } from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import type { Ticker, Candle } from "@revolut/revolut-x-api";

const SAVED_KEY = vi.hoisted(() => `u8jz${"x".repeat(56)}mxgJ`);
const mockGetTickers = vi.fn();
const mockGetCandles = vi.fn();
const mockGetOrderBook = vi.fn();

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
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
    loadConfig: () => ({ api_key: SAVED_KEY }),
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

import { OUTAGE_ALERT_MS } from "../src/engine/outage-watch.js";
import { savedKeyLabel } from "../src/engine/exchange-alerts.js";
import {
  ForegroundMonitor,
  proximity,
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

function tickerResponse(symbol: string, mid: string, indexPrice = mid) {
  return {
    data: [
      {
        symbol,
        mid,
        index_price: indexPrice,
        bid: mid,
        ask: mid,
        last_price: mid,
      },
    ],
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

  it("evaluates the alert against a healthy index price", async () => {
    mockGetTickers.mockResolvedValue(
      tickerResponse("BTC-USD", "99000", "103000"),
    );
    const mon = new ForegroundMonitor(makeSpec(), []);

    const result = await runSingleTick(mon);

    expect(result.price?.toString()).toBe("103000");
    expect(result.evalResult?.conditionMet).toBe(true);
    expect(result.triggered).toBe(true);
  });

  it("falls back to mid when index price drift is unhealthy", async () => {
    mockGetTickers.mockResolvedValue(
      tickerResponse("BTC-USD", "99000", "105000"),
    );
    const mon = new ForegroundMonitor(makeSpec(), []);

    const result = await runSingleTick(mon);

    expect(result.price?.toString()).toBe("99000");
    expect(result.evalResult?.conditionMet).toBe(false);
    expect(result.triggered).toBe(false);
  });

  function orderBook(bid: string, ask: string) {
    return {
      data: {
        bids: [{ price: "100", quantity: bid, orderCount: 1 }],
        asks: [{ price: "101", quantity: ask, orderCount: 1 }],
      },
    };
  }

  it("reads the order book imbalance from the client's levels", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
    mockGetOrderBook.mockResolvedValue(orderBook("220000", "20000"));
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "obi",
        config: { direction: "above", threshold: "0.3" },
      }),
      [CONN],
    );

    const result = await runSingleTick(mon);

    expect(result.evalResult?.current).toMatchObject({
      label: "OBI",
      value: "0.8333",
    });
    expect(result.triggered).toBe(true);
    expect(mockGetOrderBook).toHaveBeenCalledWith("BTC-USD", { limit: 20 });
  });

  it("shows an indicator it can't compute as an error on that check", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
    mockGetOrderBook.mockResolvedValue(orderBook("abc", "20000"));
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "obi",
        config: { direction: "above", threshold: "0.3" },
      }),
      [CONN],
    );

    const result = await runSingleTick(mon);

    expect(result.error).toMatch(/^Could not evaluate obi: .*abc/);
    expect(result.triggered).toBe(false);
  });

  it("doesn't report sell pressure on a book full of buyers", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
    mockGetOrderBook.mockResolvedValue(orderBook("220000", "20000"));
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "obi",
        config: { direction: "below", threshold: "0.3" },
      }),
      [CONN],
    );

    const result = await runSingleTick(mon);

    expect(result.triggered).toBe(false);
    expect(mockSendWithRetries).not.toHaveBeenCalled();
  });

  it("does not re-notify on consecutive conditions met", async () => {
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    const r1 = await runSingleTick(mon);
    expect(r1.triggered).toBe(true);

    const r2 = await runSingleTick(mon);
    expect(r2.triggered).toBe(false);
    expect(r2.holding).toBe(true);
    expect(r2.notified).toBe(false);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(1);
  });

  it("draws the triggered box only on the check that triggers", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const lines: string[] = [];

    // when
    for (let i = 0; i < 3; i++) {
      lines.push(...(await printedTick(mon)));
    }

    // then
    const text = stripVTControlCharacters(lines.join("\n"));
    expect(text.match(/TRIGGERED/g)).toHaveLength(1);
    expect(text.match(/◆ still met/g)).toHaveLength(2);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(1);
  });

  it("fills the proximity bar by the numbers, also for tiny prices", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "0.00000005"));
    const mon = new ForegroundMonitor(
      makeSpec({ config: { direction: "above", threshold: "0.0000001" } }),
      [CONN],
    );

    // when
    const text = stripVTControlCharacters((await printedTick(mon)).join("\n"));

    // then
    expect(text.match(/█/g)).toHaveLength(10);
    expect(text).toContain("Price: 0.00000005");
  });

  it("writes tiny prices without exponents in the alert", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "0.00000015"));
    const mon = new ForegroundMonitor(
      makeSpec({ config: { direction: "above", threshold: "0.0000001" } }),
      [CONN],
    );

    // when
    const result = await runSingleTick(mon);

    // then
    expect(result.evalResult?.detail).toContain("ABOVE 0.0000001");
    expect(result.evalResult?.detail).toContain("Current price: 0.00000015");
  });

  it("shows an empty order book as such", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
    mockGetOrderBook.mockResolvedValue({ data: { bids: [], asks: [] } });
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "obi",
        config: { direction: "above", threshold: "0.3" },
      }),
      [CONN],
    );

    // when
    const text = stripVTControlCharacters((await printedTick(mon)).join("\n"));

    // then
    expect(text).toContain("OBI: empty book");
  });

  it("asks for the hourly candles of a fixed window", async () => {
    // given
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
    mockGetCandles.mockResolvedValue({ data: [] });
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "rsi",
        config: { direction: "above", threshold: "70", period: 14 },
      }),
      [CONN],
    );

    // when
    try {
      await runSingleTick(mon);
    } finally {
      vi.useRealTimers();
    }

    // then
    const hour = 60 * 60 * 1000;
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", {
      interval: 60,
      startDate: Math.floor(now / hour) * hour - 101 * hour,
    });
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

describe("monitor alerts that match what happened", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockSendWithRetries.mockResolvedValue({ success: true });
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "100"));
  });

  function candlesFrom(closes: number[], laterHours = 0) {
    const start =
      Date.now() - closes.length * 3_600_000 + laterHours * 3_600_000;
    return {
      data: closes.map((close, index) => ({
        start: start + index * 3_600_000,
        open: String(close),
        high: String(close),
        low: String(close),
        close: String(close),
        volume: "1",
      })),
    };
  }

  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 40 }, (_, i) => 140 - i);

  function crossMonitor() {
    const mon = new ForegroundMonitor(
      makeSpec({
        alertType: "ema_cross",
        config: { direction: "bullish", fast_period: 9, slow_period: 21 },
      }),
      [CONN],
    );
    (
      mon as unknown as { _candleCache: { needsRefresh: () => boolean } }
    )._candleCache.needsRefresh = () => true;
    return mon;
  }

  it("arms a crossover monitor in a running uptrend without an alert", async () => {
    // given
    mockGetCandles.mockResolvedValue(candlesFrom(rising));
    const mon = crossMonitor();

    // when
    const first = await runSingleTick(mon);
    const second = await runSingleTick(mon);

    // then
    expect(first.armedWhileMet).toBe(true);
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(mockSendWithRetries).not.toHaveBeenCalled();
  });

  it("alerts once the trend in place at start breaks and forms again", async () => {
    // given
    const mon = crossMonitor();
    mockGetCandles.mockResolvedValue(candlesFrom(rising));
    await runSingleTick(mon);

    // when
    mockGetCandles.mockResolvedValue(candlesFrom([...rising, ...falling]));
    const broken = await runSingleTick(mon);
    mockGetCandles.mockResolvedValue(
      candlesFrom([...rising, ...falling, ...rising]),
    );
    const formed = await runSingleTick(mon);

    // then
    expect(broken.triggered).toBe(false);
    expect(formed.notified).toBe(true);
    expect(mockSendWithRetries).toHaveBeenCalledOnce();
  });

  it("counts a ticker with no price as an outage", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    mockGetTickers.mockResolvedValue({ data: [] });
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    // when
    await runSingleTick(mon);
    vi.setSystemTime(Date.now() + OUTAGE_ALERT_MS);
    await runSingleTick(mon);
    vi.useRealTimers();

    // then
    expect(mockSendWithRetries).toHaveBeenCalledWith(
      "tok",
      "123",
      expect.stringContaining("no data from Revolut X for 5 minutes"),
    );
  });

  it("alerts once on a fresh crossover after the first check", async () => {
    // given
    const mon = crossMonitor();
    mockGetCandles.mockResolvedValue(candlesFrom(falling));
    await runSingleTick(mon);

    // when
    mockGetCandles.mockResolvedValue(candlesFrom([...falling, ...rising]));
    const crossed = await runSingleTick(mon);
    const after = await runSingleTick(mon);

    // then
    expect(crossed.notified).toBe(true);
    expect(after.notified).toBe(false);
    expect(mockSendWithRetries).toHaveBeenCalledOnce();
  });

  it("alerts a crossover at most once per hourly candle", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const mon = crossMonitor();
    mockGetCandles.mockResolvedValue(candlesFrom(falling));
    await runSingleTick(mon);
    const flips = [
      candlesFrom([...falling, ...rising]),
      candlesFrom([...falling, ...rising, ...falling]),
      candlesFrom([...falling, ...rising, ...falling, ...rising]),
      candlesFrom([...falling, ...rising, ...falling, ...rising], 1),
      candlesFrom(
        [...falling, ...rising, ...falling, ...rising, ...falling],
        1,
      ),
      candlesFrom(
        [...falling, ...rising, ...falling, ...rising, ...falling, ...rising],
        1,
      ),
    ];

    // when
    const ticks: Array<{ result: TickResult; lines: string[] }> = [];
    for (const candles of flips) {
      mockGetCandles.mockResolvedValue(candles);
      ticks.push(await tickWithOutput(mon));
    }

    // then
    expect(ticks.map(({ result }) => result.notified)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(mockSendWithRetries).toHaveBeenCalledTimes(2);
    expect(stripVTControlCharacters(ticks[2].lines.join("\n"))).toContain(
      "◆ alerted this hour",
    );
  });

  it("still alerts a threshold monitor whose condition holds at start", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    // when
    const result = await runSingleTick(mon);

    // then
    expect(result.notified).toBe(true);
  });

  it("says the notification failed instead of notified", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    mockSendWithRetries.mockResolvedValue({
      success: false,
      error: "HTTP 403: Forbidden: bot was blocked by the user",
    });
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const internals = mon as unknown as {
      _client: unknown;
      _runTick: () => Promise<TickResult>;
      _printTick: (result: TickResult) => void;
    };
    const { RevolutXClient } = await import("@revolut/revolut-x-api");
    internals._client = new RevolutXClient();

    // when
    const result = await internals._runTick();
    internals._printTick(result);
    log.mockRestore();

    // then
    const printed = lines.map((line) => stripVTControlCharacters(line));
    const box = printed.findIndex((line) => line.includes("TRIGGERED"));
    expect(result.notified).toBe(false);
    expect(result.deliveryFailures).toBe(1);
    expect(printed[box]).toContain("\u2717 Notification failed");
    expect(printed.slice(box + 1)).toEqual([
      "  \u2717 Telegram: HTTP 403: Forbidden: bot was blocked by the user",
      "    Test it with: revx connector telegram test conn-1",
    ]);
    expect(printed.join("\n")).not.toContain("Notified");
  });

  it("says why one of two connections missed a triggered alert", async () => {
    // given
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "105000"));
    mockSendWithRetries
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: false,
        error: "HTTP 401: Unauthorized",
      });
    const mon = new ForegroundMonitor(makeSpec(), [
      CONN,
      { ...CONN, id: "conn-2" },
    ]);

    // when
    const { lines } = await tickWithOutput(mon);

    // then
    const printed = lines.map((line) => stripVTControlCharacters(line));
    expect(printed.join("\n")).toContain(
      "\u2713 Notified (1 of 2 connections)",
    );
    expect(printed.slice(-2)).toEqual([
      "  \u2717 Telegram: HTTP 401: Unauthorized",
      "    Test it with: revx connector telegram test conn-2",
    ]);
  });

  it("sends one message after 5 minutes without data and one when it is back", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    mockGetTickers.mockRejectedValue(new Error("fetch failed"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    // when
    await runSingleTick(mon);
    vi.setSystemTime(Date.now() + OUTAGE_ALERT_MS - 1000);
    await runSingleTick(mon);
    const beforeFiveMinutes = mockSendWithRetries.mock.calls.length;
    vi.setSystemTime(Date.now() + 2000);
    await runSingleTick(mon);
    await runSingleTick(mon);
    const duringOutage = mockSendWithRetries.mock.calls.map((call) => call[2]);
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    await runSingleTick(mon);
    await runSingleTick(mon);
    vi.useRealTimers();

    // then
    const messages = mockSendWithRetries.mock.calls.map((call) => call[2]);
    expect(beforeFiveMinutes).toBe(0);
    expect(duringOutage).toEqual([
      expect.stringContaining(
        "Monitor Price Threshold BTC-USD: no data from Revolut X for 5 minutes. Still trying.",
      ),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(
      "Monitor Price Threshold BTC-USD: data from Revolut X is back after 5 minutes.",
    );
  });

  it("alerts a refused key at once, only once, and when it works again", async () => {
    // given
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    mockGetTickers.mockRejectedValue(
      new AuthenticationError("Unable to resolve API key"),
    );
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    // when
    await runSingleTick(mon);
    await runSingleTick(mon);
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    await runSingleTick(mon);

    // then
    const messages = mockSendWithRetries.mock.calls.map((call) => call[2]);
    expect(messages).toEqual([
      "Monitor Price Threshold BTC-USD: Revolut X refused the API key u8jz****mxgJ with 401 Unable to resolve API key. Check the API key and the private key with revx configure, then start the monitor again.",
      "Monitor Price Threshold BTC-USD: Revolut X accepts the API key again.",
    ]);
    expect(messages.join("\n")).not.toContain(SAVED_KEY);
  });

  it("sends a refused-key alert again a minute after it was not delivered and prints it once", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    mockGetTickers.mockRejectedValue(
      new AuthenticationError("Unable to resolve API key"),
    );
    mockSendWithRetries.mockResolvedValueOnce({
      success: false,
      error: "fetch failed",
    });
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    const printed: string[] = [];

    // when
    for (const gap of [0, 30_000, 31_000, 30_000]) {
      vi.setSystemTime(Date.now() + gap);
      printed.push(...(await tickWithOutput(mon)).lines);
    }
    vi.useRealTimers();

    // then
    const messages = mockSendWithRetries.mock.calls.map((call) => call[2]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(messages[0]);
    expect(
      printed.filter((line) => line.includes("refused the API key")),
    ).toHaveLength(1);
  });

  it("sends a lost recovery message again a minute later", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    mockGetTickers.mockRejectedValueOnce(
      new AuthenticationError("Unable to resolve API key"),
    );
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    await runSingleTick(mon);
    mockSendWithRetries.mockResolvedValueOnce({
      success: false,
      error: "fetch failed",
    });

    // when
    for (const gap of [10_000, 30_000, 31_000, 30_000]) {
      vi.setSystemTime(Date.now() + gap);
      await runSingleTick(mon);
    }
    vi.useRealTimers();

    // then
    const messages = mockSendWithRetries.mock.calls.map((call) => call[2]);
    expect(messages.slice(1)).toEqual([
      "Monitor Price Threshold BTC-USD: Revolut X accepts the API key again.",
      "Monitor Price Threshold BTC-USD: Revolut X accepts the API key again.",
    ]);
  });

  it("prints that the key works again before the price line of the same check", async () => {
    // given
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    mockGetTickers.mockRejectedValueOnce(
      new AuthenticationError("Unable to resolve API key"),
    );
    mockGetTickers.mockResolvedValue(tickerResponse("BTC-USD", "95000"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);
    await runSingleTick(mon);

    // when
    const { lines } = await tickWithOutput(mon);

    // then
    const printed = lines.map((line) => stripVTControlCharacters(line));
    expect(printed[0]).toContain("Revolut X accepts the API key again.");
    expect(printed[1]).toContain("95,000");
  });

  it("gives the permission advice for a key refused with 403", async () => {
    // given
    const { ForbiddenError } = await import("@revolut/revolut-x-api");
    mockGetTickers.mockRejectedValue(new ForbiddenError("Forbidden"));
    const mon = new ForegroundMonitor(makeSpec(), [CONN]);

    // when
    await runSingleTick(mon);

    // then
    expect(mockSendWithRetries.mock.calls[0][2]).toContain(
      "with 403 Forbidden. Check that the public key is added in Revolut X, that the key has the permissions it needs and that 'Allow usage via Revolut X MCP and CLI' is ticked. The monitor goes on by itself once the key works.",
    );
  });
});

describe("proximity", () => {
  it.each([
    ["price", 90, 100, "above", 0.9],
    ["price", 110, 100, "below", 100 / 110],
    ["rsi", 35, 30, "below", 30 / 35],
    ["obi", 0, 0.5, "above", 0.5 / 0.75],
    ["obi", 0, -0.5, "below", 0.5 / 0.75],
    ["price_change_pct", -2, 4, "fall", 0.5],
    ["price_change_pct", -2, 4, "rise", 0],
  ])(
    "%s at %s against %s %s fills %s",
    (type, current, threshold, direction, expected) => {
      expect(proximity(type, current, threshold, direction)).toBeCloseTo(
        expected,
      );
    },
  );

  it.each([
    ["spread", 0, 0.5, "above", 0],
    ["spread", 0, 0.5, "below", 1],
    ["obi", -0.2, 0, "above", 0.8],
    ["volume_spike", 3, 2, "above", 1.5],
  ])(
    "%s at %s against %s %s fills %s",
    (type, current, threshold, direction, expected) => {
      expect(proximity(type, current, threshold, direction)).toBeCloseTo(
        expected,
      );
    },
  );

  it("draws no bar for a threshold it can't compare against", () => {
    expect(proximity("price", 10, 0, "above")).toBeNull();
    expect(proximity("obi", 0.2, -1, "above")).toBeNull();
    expect(proximity("obi", 0.2, 1, "below")).toBeNull();
  });
});

describe("ForegroundMonitor.formatConfigHuman", () => {
  it.each([
    ["0.0000001", "Above $0.0000001"],
    ["82500.123456", "Above $82,500.123456"],
    ["1234567", "Above $1,234,567"],
  ])("shows a price threshold of %s exactly", (threshold, expected) => {
    expect(
      ForegroundMonitor.formatConfigHuman(
        "price",
        { direction: "above", threshold },
        "$",
      ),
    ).toBe(expected);
  });
});

describe("ForegroundMonitor.buildMaps", () => {
  it("parses ticker data into price and ticker maps", () => {
    const tickers = [
      {
        symbol: "BTC-USD",
        mid: "100000",
        index_price: "100500",
        bid: "99990",
        ask: "100010",
        last_price: "99999",
      },
      {
        symbol: "ETH-USD",
        mid: null,
        index_price: "3500",
        bid: null,
        ask: null,
        last_price: "3500",
      },
    ];
    const [priceMap, tickerMap] = ForegroundMonitor.buildMaps(
      tickers as unknown as Ticker[],
    );

    expect(priceMap.get("BTC-USD")?.toString()).toBe("100500");
    expect(tickerMap.get("BTC-USD")?.bid?.toString()).toBe("99990");
    expect(tickerMap.get("BTC-USD")?.ask?.toString()).toBe("100010");
    expect(priceMap.get("ETH-USD")?.toString()).toBe("3500");
  });

  it("normalizes slash-separated symbols", () => {
    const tickers = [
      {
        symbol: "BTC/USD",
        mid: "100000",
        index_price: "100500",
        bid: null,
        ask: null,
        last_price: "100000",
      },
    ];
    const [priceMap] = ForegroundMonitor.buildMaps(
      tickers as unknown as Ticker[],
    );

    expect(priceMap.get("BTC/USD")?.toString()).toBe("100500");
    expect(priceMap.get("BTC-USD")?.toString()).toBe("100500");
  });

  it("skips tickers with invalid price", () => {
    const tickers = [
      {
        symbol: "BAD",
        mid: "not-a-number",
        index_price: "100",
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

async function tickWithOutput(
  mon: ForegroundMonitor,
): Promise<{ result: TickResult; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const internals = mon as unknown as {
    _client: unknown;
    _keyLabel: string | null;
    _runTick: () => Promise<TickResult>;
    _printTick: (result: TickResult) => void;
  };
  try {
    if (!internals._client) {
      const { RevolutXClient } = await import("@revolut/revolut-x-api");
      internals._client = new RevolutXClient();
      internals._keyLabel = savedKeyLabel();
    }
    const result = await internals._runTick();
    internals._printTick(result);
    return { result, lines };
  } finally {
    spy.mockRestore();
  }
}

async function printedTick(mon: ForegroundMonitor): Promise<string[]> {
  return (await tickWithOutput(mon)).lines;
}

async function runSingleTick(mon: ForegroundMonitor): Promise<TickResult> {
  return (await tickWithOutput(mon)).result;
}
