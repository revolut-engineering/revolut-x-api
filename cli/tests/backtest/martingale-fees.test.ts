import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runMartingaleBacktest,
  type MartingaleBacktestParams,
} from "../../src/shared/backtest/martingale-engine.js";
import { TAKER_FEE_RATE } from "../../src/engine/grid-math.js";

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number) {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

const PARAMS: MartingaleBacktestParams = {
  priceDeviation: d("0.02"),
  safetyOrderVolumeScale: d("2"),
  maxSafetyOrders: 2,
  takeProfit: d("0.015"),
  stopLoss: d("0.15"),
  investment: d("1000000"),
};

describe("martingale taker fees", () => {
  it("takes 9 bps off the market entry base", () => {
    // given
    const result = runMartingaleBacktest(
      [flat(100_000), flat(100_000)],
      PARAMS,
    );

    // when
    const entry = result.trades.find((t) => t.label === "ENTRY");

    // then
    expect(entry).toBeDefined();
    const grossBase = entry!.quoteValue
      .div(entry!.price)
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);
    const netBase = entry!.quoteValue
      .div(entry!.price)
      .times(d(1).minus(TAKER_FEE_RATE))
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);

    expect(netBase.lt(grossBase)).toBe(true);
    expect(entry!.quantity.toString()).toBe(netBase.toString());
  });

  it("nets 9 bps off stop-loss liquidation proceeds", () => {
    // given — drops through both safety orders and the stop-loss
    const result = runMartingaleBacktest(
      [flat(100_000), flat(96_000), flat(80_000)],
      PARAMS,
    );

    // when
    const sl = result.trades.find((t) => t.label === "STOP-LOSS");

    // then
    expect(result.stopLossCount).toBeGreaterThan(0);
    expect(sl).toBeDefined();
    const gross = sl!.quantity.times(sl!.price);
    const net = gross.times(d(1).minus(TAKER_FEE_RATE));

    expect(sl!.quoteValue.lt(gross)).toBe(true);
    expect(sl!.quoteValue.minus(net).abs().lt(d("0.01"))).toBe(true);
  });

  it("leaves the maker take-profit exit fee-free", () => {
    // given — dips to fill a safety order, then rallies through take-profit
    const result = runMartingaleBacktest(
      [flat(100_000), flat(97_000), flat(110_000)],
      PARAMS,
    );

    // when
    const tp = result.trades.find((t) => t.label === "TP");

    // then
    expect(tp).toBeDefined();
    const grossProceeds = tp!.quantity
      .times(tp!.price)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    expect(tp!.quoteValue.toString()).toBe(grossProceeds.toString());
  });
});
