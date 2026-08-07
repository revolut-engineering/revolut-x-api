import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runMartingaleBacktest,
  optimizeMartingaleParams,
  type MartingaleBacktestParams,
} from "../../src/shared/backtest/martingale-engine.js";
import { runMartingaleBacktest as runMartingaleBacktestMcp } from "../../../mcp/src/shared/backtest/martingale-engine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number) {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

// Shared params — same as scenarios tests so expected values are known.
const PARAMS: MartingaleBacktestParams = {
  priceDeviation: d("0.02"),
  safetyOrderVolumeScale: d("2"),
  maxSafetyOrders: 2,
  takeProfit: d("0.015"),
  stopLoss: d("0.15"),
  investment: d("1000"),
};

// ── B — CLI runMartingaleBacktest ↔ MCP runMartingaleBacktest ─────────────────
//
// Both engines implement the same algorithm independently.
// Flat candles make fill conditions deterministic and identical across engines.

describe("B — CLI runMartingaleBacktest ↔ MCP runMartingaleBacktest (exact equality)", () => {
  // B.1: single TP cycle — all key metrics match
  it("B.1: single TP cycle: both engines produce identical results", () => {
    const candles = [flat(100_000), flat(97_999), flat(99_999)];
    const cli = runMartingaleBacktest(candles, PARAMS);
    const mcp = runMartingaleBacktestMcp(candles, PARAMS);

    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.completedCycles).toBe(mcp.completedCycles);
    expect(cli.winningCycles).toBe(mcp.winningCycles);
    expect(cli.totalTrades).toBe(mcp.totalTrades);
    expect(cli.stopLossCount).toBe(mcp.stopLossCount);
    expect(cli.finalBase.eq(mcp.finalBase)).toBe(true);
    expect(cli.finalCost.eq(mcp.finalCost)).toBe(true);
    expect(cli.totalReturn.eq(mcp.totalReturn)).toBe(true);
    expect(cli.maxDrawdown.eq(mcp.maxDrawdown)).toBe(true);
  });

  // B.2: stop-loss — both engines stop at same candle with same P&L
  it("B.2: stop-loss: both engines trigger on the same candle", () => {
    const candles = [flat(100_000), flat(97_999), flat(84_999)];
    const cli = runMartingaleBacktest(candles, PARAMS);
    const mcp = runMartingaleBacktestMcp(candles, PARAMS);

    expect(cli.stopLossCount).toBe(1);
    expect(cli.stopLossCount).toBe(mcp.stopLossCount);
    expect(cli.totalTrades).toBe(mcp.totalTrades);
    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.finalBase.eq(mcp.finalBase)).toBe(true);
  });

  // B.3: multi-cycle — both engines complete the same number of cycles
  it("B.3: two TP cycles: both engines produce identical cycle count and P&L", () => {
    const candles = [
      flat(100_000),
      flat(97_999),
      flat(99_999),
      flat(97_999),
      flat(99_999),
    ];
    const cli = runMartingaleBacktest(candles, PARAMS);
    const mcp = runMartingaleBacktestMcp(candles, PARAMS);

    expect(cli.completedCycles).toBe(2);
    expect(cli.completedCycles).toBe(mcp.completedCycles);
    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.totalReturn.eq(mcp.totalReturn)).toBe(true);
    expect(cli.maxDrawdown.eq(mcp.maxDrawdown)).toBe(true);
  });
});

// ── C — runMartingaleBacktest ↔ optimizeMartingaleParams consistency ──────────
//
// optimizeMartingaleParams calls runMartingaleBacktest internally.
// A single-combination optimize must return exactly the same metrics
// as a direct runMartingaleBacktest call with the same parameters.

describe("C — runMartingaleBacktest ↔ optimizeMartingaleParams consistency", () => {
  // C.1: profitable TP cycle — optimize matches backtest exactly
  //
  // Two complete TP cycles give non-zero realizedPnl to validate P&L propagation.
  it("C.1: single-combo optimize matches direct backtest (TP cycles)", () => {
    const candles = [
      flat(100_000),
      flat(94_118),
      flat(96_758), // TP fires (all 3 levels filled)
      flat(94_118),
      flat(96_758), // second cycle TP
    ];

    const bt = runMartingaleBacktest(candles, PARAMS);
    const results = optimizeMartingaleParams(candles, PARAMS.investment, {
      priceDeviations: [PARAMS.priceDeviation],
      scales: [PARAMS.safetyOrderVolumeScale],
      maxSafetyOrdersList: [PARAMS.maxSafetyOrders],
      takeProfits: [PARAMS.takeProfit],
      stopLoss: PARAMS.stopLoss,
    });

    expect(results).toHaveLength(1);
    const opt = results[0];

    expect(opt.realizedPnl.eq(bt.realizedPnl)).toBe(true);
    expect(opt.completedCycles).toBe(bt.completedCycles);
    expect(opt.stopLossCount).toBe(bt.stopLossCount);
    expect(opt.totalReturn.eq(bt.totalReturn)).toBe(true);
    expect(opt.maxDrawdown.eq(bt.maxDrawdown)).toBe(true);
  });

  // C.2: stop-loss scenario — optimize and backtest agree on SL outcome
  //
  // After SL fires, stopped=true, so no further cycles run.
  // Both backtest and optimize must report stopLossCount=1 and the same P&L.
  it("C.2: stop-loss combo — optimize matches backtest P&L and SL count", () => {
    const candles = [flat(100_000), flat(97_999), flat(84_999)];

    const bt = runMartingaleBacktest(candles, PARAMS);
    const results = optimizeMartingaleParams(candles, PARAMS.investment, {
      priceDeviations: [PARAMS.priceDeviation],
      scales: [PARAMS.safetyOrderVolumeScale],
      maxSafetyOrdersList: [PARAMS.maxSafetyOrders],
      takeProfits: [PARAMS.takeProfit],
      stopLoss: PARAMS.stopLoss,
    });

    expect(results).toHaveLength(1);
    const opt = results[0];

    expect(opt.stopLossCount).toBe(1);
    expect(opt.stopLossCount).toBe(bt.stopLossCount);
    expect(opt.realizedPnl.eq(bt.realizedPnl)).toBe(true);
    expect(opt.completedCycles).toBe(bt.completedCycles);
  });
});
