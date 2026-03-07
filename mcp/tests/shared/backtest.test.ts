import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";

import {
  createGrid,
  simulateCandle,
  runBacktest,
  optimizeGridParams,
} from "../../src/shared/backtest/engine.js";

import type {
  GridLevel,
  BacktestResult,
} from "../../src/shared/backtest/engine.js";

function candle(
  close: string,
  low?: string,
  high?: string,
): Record<string, Decimal> {
  const c = new Decimal(close);
  return {
    close: c,
    low: low ? new Decimal(low) : c,
    high: high ? new Decimal(high) : c,
  };
}

function emptyResult(): BacktestResult {
  return {
    totalTrades: 0,
    totalBuys: 0,
    totalSells: 0,
    totalFees: new Decimal(0),
    realizedPnl: new Decimal(0),
    finalBtc: new Decimal(0),
    finalUsd: new Decimal(0),
    maxDrawdown: new Decimal(0),
    tradeLog: [],
  };
}

describe("createGrid", () => {
  it("correct level count", () => {
    const levels = createGrid(new Decimal("100"), 5, new Decimal("0.10"));
    expect(levels).toHaveLength(5);
  });

  it("buy orders placed below start price", () => {
    const levels = createGrid(new Decimal("100"), 5, new Decimal("0.10"));
    for (const lv of levels) {
      if (lv.price.lt(100)) {
        expect(lv.hasBuyOrder).toBe(true);
      } else {
        expect(lv.hasBuyOrder).toBe(false);
      }
    }
  });

  it("levels sorted ascending", () => {
    const levels = createGrid(new Decimal("100"), 10, new Decimal("0.20"));
    const prices = levels.map((lv) => lv.price);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i].gte(prices[i - 1])).toBe(true);
    }
  });

  it("grid within expected range", () => {
    const levels = createGrid(new Decimal("100"), 5, new Decimal("0.10"));
    expect(levels[0].price.gte(89)).toBe(true);
    expect(levels[levels.length - 1].price.lte(111)).toBe(true);
  });
});

describe("simulateCandle", () => {
  it("buy triggered", () => {
    const levels: GridLevel[] = [
      {
        price: new Decimal("95"),
        index: 0,
        hasBuyOrder: true,
        hasPosition: false,
        btcHeld: new Decimal(0),
      },
      {
        price: new Decimal("100"),
        index: 1,
        hasBuyOrder: false,
        hasPosition: false,
        btcHeld: new Decimal(0),
      },
    ];
    const result = emptyResult();
    const usd = simulateCandle(
      levels,
      new Decimal("94"),
      new Decimal("96"),
      new Decimal("100"),
      result,
      new Decimal("1000"),
      2,
    );
    expect(result.totalBuys).toBe(1);
    expect(levels[0].hasPosition).toBe(true);
    expect(levels[0].hasBuyOrder).toBe(false);
    expect(usd.lt(1000)).toBe(true);
  });

  it("sell triggered", () => {
    const levels: GridLevel[] = [
      {
        price: new Decimal("95"),
        index: 0,
        hasBuyOrder: false,
        hasPosition: true,
        btcHeld: new Decimal("1"),
      },
      {
        price: new Decimal("100"),
        index: 1,
        hasBuyOrder: false,
        hasPosition: false,
        btcHeld: new Decimal(0),
      },
    ];
    const result = emptyResult();
    const usd = simulateCandle(
      levels,
      new Decimal("95"),
      new Decimal("101"),
      new Decimal("100"),
      result,
      new Decimal("0"),
      2,
    );
    expect(result.totalSells).toBe(1);
    expect(levels[0].hasPosition).toBe(false);
    expect(levels[0].hasBuyOrder).toBe(true);
    expect(usd.gt(0)).toBe(true);
  });

  it("fee applied", () => {
    const levels: GridLevel[] = [
      {
        price: new Decimal("95"),
        index: 0,
        hasBuyOrder: true,
        hasPosition: false,
        btcHeld: new Decimal(0),
      },
      {
        price: new Decimal("100"),
        index: 1,
        hasBuyOrder: false,
        hasPosition: false,
        btcHeld: new Decimal(0),
      },
    ];
    const result = emptyResult();
    simulateCandle(
      levels,
      new Decimal("94"),
      new Decimal("96"),
      new Decimal("100"),
      result,
      new Decimal("1000"),
      2,
      new Decimal("0.001"),
    );
    expect(result.totalFees.gt(0)).toBe(true);
  });
});

describe("runBacktest", () => {
  it("empty candles → no trades", () => {
    const result = runBacktest([], 5, new Decimal("0.10"), new Decimal("1000"));
    expect(result.totalTrades).toBe(0);
    expect(result.finalUsd.eq(0)).toBe(true);
  });

  it("flat price → no sells", () => {
    const candles = Array(10).fill(candle("100", "100", "100"));
    const result = runBacktest(
      candles,
      5,
      new Decimal("0.10"),
      new Decimal("1000"),
    );
    expect(result.totalSells).toBe(0);
  });

  it("oscillating prices produce trades", () => {
    const candles: Record<string, Decimal>[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(candle("100", "90", "100"));
      candles.push(candle("105", "100", "110"));
    }
    const result = runBacktest(
      candles,
      5,
      new Decimal("0.10"),
      new Decimal("1000"),
    );
    expect(result.totalBuys).toBeGreaterThan(0);
    expect(result.totalSells).toBeGreaterThan(0);
    expect(result.realizedPnl.gt(0)).toBe(true);
  });

  it("fee reduces pnl", () => {
    const candles: Record<string, Decimal>[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(candle("100", "90", "100"));
      candles.push(candle("105", "100", "110"));
    }
    const noFee = runBacktest(
      candles,
      5,
      new Decimal("0.10"),
      new Decimal("1000"),
    );
    const withFee = runBacktest(
      candles,
      5,
      new Decimal("0.10"),
      new Decimal("1000"),
      new Decimal("0.001"),
    );
    expect(withFee.realizedPnl.lt(noFee.realizedPnl)).toBe(true);
  });

  it("max drawdown tracked", () => {
    const candles = [
      candle("100", "100", "100"),
      candle("80", "75", "100"),
      candle("70", "70", "80"),
    ];
    const result = runBacktest(
      candles,
      10,
      new Decimal("0.20"),
      new Decimal("1000"),
    );
    expect(result.maxDrawdown.gt(0)).toBe(true);
  });
});

describe("optimizeGridParams", () => {
  it("returns sorted by totalReturn descending", () => {
    const candles: Record<string, Decimal>[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candle("100", "90", "100"));
      candles.push(candle("105", "100", "110"));
    }
    const results = optimizeGridParams(
      candles,
      [5, 10],
      [new Decimal("0.05"), new Decimal("0.10")],
      new Decimal("1000"),
    );
    expect(results).toHaveLength(4);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].totalReturn.gte(results[i].totalReturn)).toBe(true);
    }
  });

  it("empty candles → empty results", () => {
    const results = optimizeGridParams([]);
    expect(results).toHaveLength(0);
  });

  it("result count matches combos", () => {
    const candles = Array(5).fill(candle("100", "90", "110"));
    const results = optimizeGridParams(
      candles,
      [5, 10, 15],
      [new Decimal("0.05"), new Decimal("0.10")],
    );
    expect(results).toHaveLength(6); // 3 * 2
  });
});
