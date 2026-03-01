import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Decimal } from "decimal.js";
import Database from "better-sqlite3";
import { migrate } from "../src/db/schema.js";
import { AlertRepo, EventRepo, TelegramConnectionRepo } from "../src/db/repositories.js";
import { CandleCache } from "../src/engine/candle-cache.js";
import { WorkerRunner } from "../src/engine/runner.js";

// ── CandleCache ──

describe("CandleCache", () => {
  it("get returns undefined for unknown pair", () => {
    const cache = new CandleCache();
    expect(cache.get("BTC-USD")).toBeUndefined();
  });

  it("put and get round-trip", () => {
    const cache = new CandleCache();
    const candles = [{ close: 100 }];
    cache.put("BTC-USD", candles);
    expect(cache.get("BTC-USD")).toEqual(candles);
  });

  it("needsRefresh returns true for unknown pair", () => {
    const cache = new CandleCache();
    expect(cache.needsRefresh("BTC-USD")).toBe(true);
  });

  it("needsRefresh returns false for fresh data", () => {
    const cache = new CandleCache();
    cache.put("BTC-USD", []);
    expect(cache.needsRefresh("BTC-USD")).toBe(false);
  });

  it("needsRefresh returns true for stale data", () => {
    const cache = new CandleCache(0); // 0-second max age
    cache.put("BTC-USD", []);
    // Stale immediately with 0 max age — need a tiny delay
    expect(cache.needsRefresh("BTC-USD")).toBe(true);
  });

  it("pairsNeedingRefresh returns stale pairs", () => {
    const cache = new CandleCache();
    cache.put("BTC-USD", []);
    const result = cache.pairsNeedingRefresh(
      new Set(["BTC-USD", "ETH-USD"]),
    );
    expect(result.has("ETH-USD")).toBe(true);
    expect(result.has("BTC-USD")).toBe(false);
  });

  it("pairsNeedingRefresh returns all when empty", () => {
    const cache = new CandleCache();
    const result = cache.pairsNeedingRefresh(
      new Set(["BTC-USD", "ETH-USD"]),
    );
    expect(result.size).toBe(2);
  });
});

// ── WorkerRunner.buildMaps ──

describe("WorkerRunner.buildMaps", () => {
  it("builds price map from tickers with mid", () => {
    const tickers = [
      { symbol: "BTC-USD", mid: "50000", bid: "49990", ask: "50010" },
    ];
    const [priceMap, tickerMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.get("BTC-USD")!.eq(50000)).toBe(true);
    expect(tickerMap.get("BTC-USD")!.bid!.eq(49990)).toBe(true);
    expect(tickerMap.get("BTC-USD")!.ask!.eq(50010)).toBe(true);
  });

  it("falls back to last_price when mid missing", () => {
    const tickers = [{ symbol: "ETH-USD", last_price: "3000" }];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.get("ETH-USD")!.eq(3000)).toBe(true);
  });

  it("normalizes / to - in symbol", () => {
    const tickers = [{ symbol: "BTC/USD", mid: "50000" }];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.has("BTC/USD")).toBe(true);
    expect(priceMap.has("BTC-USD")).toBe(true);
    expect(priceMap.get("BTC-USD")!.eq(50000)).toBe(true);
  });

  it("skips tickers without symbol", () => {
    const tickers = [{ mid: "50000" }];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.size).toBe(0);
  });

  it("skips tickers without mid or last_price", () => {
    const tickers = [{ symbol: "BTC-USD" }];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.size).toBe(0);
  });

  it("skips invalid price values", () => {
    const tickers = [{ symbol: "BTC-USD", mid: "invalid" }];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.size).toBe(0);
  });

  it("handles missing bid/ask gracefully", () => {
    const tickers = [{ symbol: "BTC-USD", mid: "50000" }];
    const [, tickerMap] = WorkerRunner.buildMaps(tickers);
    const info = tickerMap.get("BTC-USD");
    expect(info!.price.eq(50000)).toBe(true);
    expect(info!.bid).toBeUndefined();
    expect(info!.ask).toBeUndefined();
  });

  it("handles multiple tickers", () => {
    const tickers = [
      { symbol: "BTC-USD", mid: "50000" },
      { symbol: "ETH-USD", mid: "3000" },
    ];
    const [priceMap] = WorkerRunner.buildMaps(tickers);
    expect(priceMap.size).toBe(2);
  });
});

// ── WorkerRunner.getStatus ──

describe("WorkerRunner.getStatus", () => {
  it("returns status when stopped", () => {
    const runner = new WorkerRunner(10);
    const status = runner.getStatus(5, 2, true);
    expect(status.running).toBe(false);
    expect(status.status).toBe("stopped");
    expect(status.active_alert_count).toBe(5);
    expect(status.enabled_connection_count).toBe(2);
    expect(status.tick_interval_sec).toBe(10);
    expect(status.credentials_configured).toBe(true);
  });

  it("returns null uptime when not started", () => {
    const runner = new WorkerRunner();
    const status = runner.getStatus(0, 0, false);
    expect(status.uptime_seconds).toBeNull();
  });

  it("returns uptime when started", async () => {
    const runner = new WorkerRunner(10);
    // Simulate start by setting internal start time
    (runner as any)._startTime = performance.now() / 1000 - 5;
    (runner as any)._running = true;
    const status = runner.getStatus(0, 0, false);
    expect(status.running).toBe(true);
    expect(status.uptime_seconds).toBeGreaterThan(4);
  });
});

// ── WorkerRunner.formatNotification ──

describe("WorkerRunner.formatNotification", () => {
  it("formats price alert without price line", () => {
    const msg = WorkerRunner.formatNotification(
      "price",
      "BTC-USD",
      new Decimal("50000"),
      { conditionMet: true, detail: "ABOVE 49000\nCurrent price: 50000" },
    );
    expect(msg).toContain("Price Alert: BTC-USD");
    expect(msg).toContain("ABOVE 49000");
    expect(msg).not.toMatch(/💰 Price: 50000$/m);
  });

  it("formats rsi alert with price line", () => {
    const msg = WorkerRunner.formatNotification(
      "rsi",
      "ETH-USD",
      new Decimal("3000"),
      { conditionMet: true, detail: "RSI(14) above 70" },
    );
    expect(msg).toContain("RSI Alert: ETH-USD");
    expect(msg).toContain("RSI(14) above 70");
    expect(msg).toContain("Price: 3000");
  });

  it("handles unknown alert type", () => {
    const msg = WorkerRunner.formatNotification(
      "custom",
      "BTC-USD",
      new Decimal("50000"),
      { conditionMet: true, detail: "" },
    );
    expect(msg).toContain("custom Alert: BTC-USD");
  });
});

// ── WorkerRunner._parseCandles ──

describe("WorkerRunner._parseCandles", () => {
  it("parses valid candles", () => {
    const raw = [
      {
        start: 1000,
        open: "100",
        high: "110",
        low: "90",
        close: "105",
        volume: "500",
      },
    ];
    const parsed = WorkerRunner._parseCandles(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].timestamp).toBe(1000);
    expect((parsed[0].close as Decimal).eq(105)).toBe(true);
  });

  it("sorts by timestamp", () => {
    const raw = [
      { start: 2000, open: "1", high: "1", low: "1", close: "1", volume: "1" },
      { start: 1000, open: "1", high: "1", low: "1", close: "1", volume: "1" },
    ];
    const parsed = WorkerRunner._parseCandles(raw);
    expect(parsed[0].timestamp).toBe(1000);
    expect(parsed[1].timestamp).toBe(2000);
  });

  it("skips non-object entries", () => {
    const raw = [null, "invalid", 42];
    const parsed = WorkerRunner._parseCandles(raw);
    expect(parsed).toHaveLength(0);
  });
});

// ── Edge triggering ──

describe("Edge triggering (_evaluateAndNotify)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPriceAlert(
    pair: string,
    direction: string,
    threshold: string,
  ): Record<string, unknown> {
    const config = JSON.stringify({ direction, threshold });
    return AlertRepo.create(db, pair, "price", config);
  }

  it("triggers alert when condition met and not previously triggered", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "40000");
    const conn = TelegramConnectionRepo.create(db, "test", "token", "chat");
    const snapshot: MarketSnapshot = {
      price: new Decimal("50000"),
    };

    // Mock _sendWithRetries
    const originalSend = WorkerRunner._sendWithRetries;
    WorkerRunner._sendWithRetries = vi.fn().mockResolvedValue({ success: true });

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      alert,
      snapshot,
      db,
      "2025-01-01T00:00:00Z",
    );

    const updated = AlertRepo.get(db, alert.id as string);
    expect(updated!.triggered).toBe(1);
    expect(updated!.last_triggered_at).toBe("2025-01-01T00:00:00Z");

    // Check events were created
    const events = EventRepo.listRecent(db);
    const categories = events.map((e) => e.category);
    expect(categories).toContain("alert_triggered");
    expect(categories).toContain("telegram_send_ok");

    WorkerRunner._sendWithRetries = originalSend;
  });

  it("does not double-trigger", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "40000");
    TelegramConnectionRepo.create(db, "test", "token", "chat");

    // Mark as already triggered
    AlertRepo.update(db, alert.id as string, { triggered: 1 });
    const triggeredAlert = AlertRepo.get(db, alert.id as string)!;

    const snapshot: MarketSnapshot = {
      price: new Decimal("50000"),
    };

    const sendMock = vi.fn().mockResolvedValue({ success: true });
    const originalSend = WorkerRunner._sendWithRetries;
    WorkerRunner._sendWithRetries = sendMock;

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      triggeredAlert,
      snapshot,
      db,
      "2025-01-01T00:00:00Z",
    );

    // Should not have sent any notifications
    expect(sendMock).not.toHaveBeenCalled();

    WorkerRunner._sendWithRetries = originalSend;
  });

  it("resets triggered when condition clears", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "60000");
    AlertRepo.update(db, alert.id as string, { triggered: 1 });
    const triggeredAlert = AlertRepo.get(db, alert.id as string)!;

    const snapshot: MarketSnapshot = {
      price: new Decimal("50000"), // Below threshold
    };

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      triggeredAlert,
      snapshot,
      db,
      "2025-01-01T00:00:00Z",
    );

    const updated = AlertRepo.get(db, alert.id as string);
    expect(updated!.triggered).toBe(0);
  });

  it("skips when price is missing", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "40000");
    const snapshot: MarketSnapshot = {};

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      alert,
      snapshot,
      db,
      "2025-01-01T00:00:00Z",
    );

    const updated = AlertRepo.get(db, alert.id as string);
    expect(updated!.triggered).toBe(0);
  });

  it("updates last_checked_at on evaluation", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "100000");
    const snapshot: MarketSnapshot = {
      price: new Decimal("50000"), // Below threshold, no trigger
    };

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      alert,
      snapshot,
      db,
      "2025-01-01T12:00:00Z",
    );

    const updated = AlertRepo.get(db, alert.id as string);
    expect(updated!.last_checked_at).toBe("2025-01-01T12:00:00Z");
  });

  it("updates current_value_json", async () => {
    const alert = createPriceAlert("BTC-USD", "above", "100000");
    const snapshot: MarketSnapshot = {
      price: new Decimal("50000"),
    };

    const runner = new WorkerRunner();
    await (runner as any)._evaluateAndNotify(
      alert,
      snapshot,
      db,
      "2025-01-01T00:00:00Z",
    );

    const updated = AlertRepo.get(db, alert.id as string);
    expect(updated!.current_value_json).toBeDefined();
    const cv = JSON.parse(updated!.current_value_json as string);
    expect(cv.label).toBe("Price");
    expect(cv.value).toBe("50000");
  });
});

// ── Settings ──

describe("WorkerRunner settings", () => {
  it("returns default settings", () => {
    const runner = new WorkerRunner(10);
    expect(runner.settings).toEqual({ tick_interval_sec: 10 });
  });

  it("updateSettings changes tick interval", () => {
    const runner = new WorkerRunner(10);
    runner.updateSettings(30);
    expect(runner.settings.tick_interval_sec).toBe(30);
  });

  it("updateSettings ignores null", () => {
    const runner = new WorkerRunner(10);
    runner.updateSettings(null);
    expect(runner.settings.tick_interval_sec).toBe(10);
  });
});

// Need to import MarketSnapshot type
import type { MarketSnapshot } from "../src/shared/indicators/evaluators.js";
