import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runBacktest,
  type BacktestTickEvent,
} from "../src/shared/backtest/index.js";
import { inlineCandles } from "../src/shared/price-source/sources/inline.js";

describe("runBacktest scenarios", () => {
  it("zero candles returns an empty result", () => {
    const r = runBacktest([], 6, new Decimal("0.10"), new Decimal(1000));
    expect(r.totalTrades).toBe(0);
    expect(r.realizedPnl.toNumber()).toBe(0);
  });

  it("ramp down from start crosses N buy levels", () => {
    const candles = inlineCandles([
      100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90,
    ]);
    const r = runBacktest(candles, 6, new Decimal("0.10"), new Decimal(1000));
    expect(r.totalBuys).toBeGreaterThan(0);
    expect(r.totalSells).toBe(0);
    expect(r.finalBase.gt(0)).toBe(true);
  });

  it("up-then-down oscillation produces buy/sell pairs", () => {
    const candles = inlineCandles([100, 95, 102, 95, 102, 95, 102]);
    const r = runBacktest(candles, 6, new Decimal("0.10"), new Decimal(1000));
    expect(r.totalBuys).toBeGreaterThan(0);
    expect(r.totalSells).toBeGreaterThan(0);
    expect(r.realizedPnl.gt(0)).toBe(true);
  });

  it("stop-loss fires when price breaches threshold", () => {
    const candles = inlineCandles([100, 95, 80]);
    const r = runBacktest(
      candles,
      6,
      new Decimal("0.10"),
      new Decimal(1000),
      false,
      false,
      85,
    );
    expect(r.stopLossTriggered).toBe(true);
  });

  it("emits onTick callback once per processed candle", () => {
    const candles = inlineCandles([100, 102, 98, 95, 101]);
    const events: BacktestTickEvent[] = [];
    runBacktest(
      candles,
      6,
      new Decimal("0.10"),
      new Decimal(1000),
      false,
      false,
      0,
      (ev) => events.push(ev),
    );
    expect(events).toHaveLength(5);
    expect(events[0].index).toBe(0);
    expect(events[4].index).toBe(4);
    expect(events[0].close.toString()).toBe("100");
  });

  it("onTick fills array is populated when trades happen", () => {
    const candles = inlineCandles([100, 95, 102]);
    const events: BacktestTickEvent[] = [];
    runBacktest(
      candles,
      6,
      new Decimal("0.10"),
      new Decimal(1000),
      false,
      false,
      0,
      (ev) => events.push(ev),
    );
    const totalFills = events.reduce((n, e) => n + e.fills.length, 0);
    expect(totalFills).toBeGreaterThan(0);
  });
});
