import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { TAKER_FEE_RATE } from "@revolut/revolut-x-api";

import {
  runMartingaleBacktest,
  type BacktestCandle,
  type MartingaleBacktestParams,
} from "../../src/shared/backtest/martingale-engine.js";

const TAKER_FEE = new Decimal(TAKER_FEE_RATE);

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number): BacktestCandle {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

function exitPrice(tradeLog: string[], label: string): Decimal {
  const line = tradeLog.find((l) => l.includes(`[${label}]`));
  expect(line).toBeDefined();
  return d(line!.match(/SELL \$([\d.]+)/)![1]);
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
    const entryPrice = d(100_000);

    // when
    const { finalBase, finalCost } = runMartingaleBacktest(
      [flat(100_000), flat(100_000)],
      PARAMS,
    );

    // then
    const grossBase = finalCost
      .div(entryPrice)
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);
    const netBase = finalCost
      .div(entryPrice)
      .times(d(1).minus(TAKER_FEE))
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);

    expect(netBase.lt(grossBase)).toBe(true);
    expect(finalBase.toString()).toBe(netBase.toString());
  });

  it("nets 9 bps off stop-loss liquidation proceeds", () => {
    // given — drops through both safety orders, then through the stop-loss
    const position = runMartingaleBacktest(
      [flat(100_000), flat(96_000)],
      PARAMS,
    );

    // when
    const result = runMartingaleBacktest(
      [flat(100_000), flat(96_000), flat(80_000)],
      PARAMS,
    );

    // then
    expect(result.stopLossCount).toBe(1);
    const slPrice = exitPrice(result.tradeLog, "STOP-LOSS");
    const gross = position.finalBase
      .times(slPrice)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const net = position.finalBase
      .times(slPrice)
      .times(d(1).minus(TAKER_FEE))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    expect(net.lt(gross)).toBe(true);
    expect(result.realizedPnl.toString()).toBe(
      net.minus(position.finalCost).toString(),
    );
  });

  it("leaves the maker take-profit exit fee-free", () => {
    // given — dips to fill a safety order, then rallies through take-profit
    const position = runMartingaleBacktest(
      [flat(100_000), flat(97_000)],
      PARAMS,
    );

    // when
    const result = runMartingaleBacktest(
      [flat(100_000), flat(97_000), flat(110_000)],
      PARAMS,
    );

    // then
    expect(result.completedCycles).toBe(1);
    const tpPrice = exitPrice(result.tradeLog, "TP");
    const grossProceeds = position.finalBase
      .times(tpPrice)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    expect(result.realizedPnl.toString()).toBe(
      grossProceeds.minus(position.finalCost).toString(),
    );
  });
});
