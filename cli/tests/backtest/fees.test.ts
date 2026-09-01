import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { runBacktest } from "../../src/shared/backtest/engine.js";
import {
  createGridPlan,
  type GridOrderConstraints,
} from "../../src/engine/grid-plan.js";
import { TAKER_FEE_RATE } from "../../src/engine/grid-math.js";

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number) {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

function sum(values: Decimal[]) {
  return values.reduce((total, value) => total.plus(value), d(0));
}

const CONSTRAINTS: GridOrderConstraints = {
  baseStep: d("0.00000001"),
  quoteStep: d("0.01"),
  minBase: d(0),
  maxBase: d(Infinity),
  minQuote: d(0),
};

function splitPlan(takerFeeRate?: Decimal) {
  return createGridPlan({
    startPrice: d(100_000),
    totalLevels: 6,
    rangePct: d("0.05"),
    investment: d(1_000),
    split: true,
    constraints: CONSTRAINTS,
    takerFeeRate,
  });
}

describe("taker fees", () => {
  it("takes 9 bps off the split market entry base and leaves its cost unchanged", () => {
    // given
    const gross = splitPlan();
    const net = splitPlan(TAKER_FEE_RATE);

    // then
    const ratio = sum(net.splitBaseByLevel).div(sum(gross.splitBaseByLevel));
    expect(ratio.toFixed(6)).toBe(d(1).minus(TAKER_FEE_RATE).toFixed(6));
    expect(sum(net.splitCostByLevel).toFixed(2)).toBe(
      sum(gross.splitCostByLevel).toFixed(2),
    );
  });

  it("nets 9 bps off stop-loss liquidation proceeds", () => {
    // given
    const candles = [flat(100_000), flat(88_000), flat(80_000)];

    // when
    const result = runBacktest(
      candles,
      6,
      d("0.05"),
      d(1_000),
      false,
      false,
      82_000,
    );
    const liquidations = result.trades.filter(
      (trade) => trade.trigger === "stop-loss",
    );

    // then
    expect(liquidations.length).toBeGreaterThan(0);
    for (const trade of liquidations) {
      const grossProceeds = trade.quantity.times(82_000);
      const netProceeds = grossProceeds.minus(
        grossProceeds.times(TAKER_FEE_RATE),
      );
      expect(netProceeds.minus(trade.quoteValue).abs().lte(d("0.01"))).toBe(
        true,
      );
      expect(trade.quoteValue.lt(grossProceeds)).toBe(true);
    }
  });

  it("leaves maker-only grid cycles fee-free", () => {
    // given
    const candles = [flat(100_000), flat(94_000), flat(106_000)];

    // when
    const result = runBacktest(candles, 6, d("0.05"), d(1_000));
    const cycles = result.trades.filter((trade) => trade.trigger === "grid");

    // then
    expect(cycles.length).toBeGreaterThan(0);
    for (const trade of cycles.filter((t) => t.side === "sell")) {
      const gross = trade.quantity.times(trade.price);
      expect(gross.minus(trade.quoteValue).abs().lte(d("0.01"))).toBe(true);
    }
  });
});
