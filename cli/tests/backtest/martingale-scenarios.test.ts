import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runMartingaleBacktest,
  type MartingaleBacktestParams,
} from "../../src/shared/backtest/martingale-engine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number) {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

// ── Shared params ─────────────────────────────────────────────────────────────
//
// entryPrice supplied by first candle close = 100_000
// dev=2%, scale=2, maxSO=2 → 3 levels total
// TP=1.5%, SL=15%, investment=1000
//
// basePct = (2−1)/(2^3−1) = 1/7
//
// Level prices (from entryPrice=100_000):
//   L0 = 100_000 × 0.98^1 = 98_000.00
//   L1 = 100_000 × 0.98^2 = 96_040.00
//   L2 = 100_000 × 0.98^3 = 94_119.20
//
// Quote sizes (investment × basePct × scale^i, ROUND_DOWN 2dp):
//   L0 = 1000 × (1/7) × 1   = 142.85
//   L1 = 1000 × (1/7) × 2   = 285.71
//   L2 = 1000 × (1/7) × 4   = 571.42
//
// Quantities (quoteSize / price, ROUND_DOWN 5dp):
//   L0 = 142.85 / 98_000   = 0.00145
//   L1 = 285.71 / 96_040   = 0.00297
//   L2 = 571.42 / 94_119.2 = 0.00607
//
// SL price = 100_000 × 0.85 = 85_000.00
//
// TP calculations (ROUND_UP 2dp):
//   L0 only:    avgEntry=98_517.24, tpPrice=99_995.00
//               revenue = 0.00145 × 99_995     = 144.99  → profit = 144.99 − 142.85 = 2.14
//   L0+L1:      avgEntry=96_960.18, tpPrice=98_414.59
//               revenue = 0.00442 × 98_414.59  = 434.99  → profit = 434.99 − 428.56 = 6.43
//   L0+L1+L2:   avgEntry=95_327.93, tpPrice=96_757.85
//               revenue = 0.01049 × 96_757.85  = 1014.98 → profit = 1014.98 − 999.98 = 15.00
//
// SL after all 3 levels filled:
//   totalQty=0.01049, totalCost=999.98
//   revenue = 0.01049 × 85_000 = 891.65 → profit = 891.65 − 999.98 = −108.33

const PARAMS: MartingaleBacktestParams = {
  priceDeviation: d("0.02"),
  safetyOrderVolumeScale: d("2"),
  maxSafetyOrders: 2,
  takeProfit: d("0.015"),
  stopLoss: d("0.15"),
  investment: d("1000"),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Martingale backtest scenarios (runMartingaleBacktest)", () => {
  // S1: price never reaches any level → no trades
  //
  // C0 100k: initCycle(100k), levels at 98k/96.04k/94.12k
  // C1 99k:  99k > 98k → no fills
  it("S1: no trades when price stays above all levels", () => {
    const candles = [flat(100_000), flat(99_000)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(0);
    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.stopLossCount).toBe(0);
  });

  // S2: price touches L0 only — initial buy fills, no TP by end of data
  //
  // C0 100k: initCycle
  // C1 97999: 97_999 ≤ 98_000 → L0 fills; 97_999 > 96_040 → L1 not filled
  //           inPosition=true, safetyOrdersFilled=0, tpPrice=99_995
  //           no sell (high 97_999 < 99_995)
  it("S2: initial buy fills, no TP triggered — partial position at end", () => {
    const candles = [flat(100_000), flat(97_999)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(1);
    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.toFixed(5)).toBe("0.00145");
    expect(r.finalCost.toFixed(2)).toBe("142.85");
    // position is underwater at close=97_999 vs cost of 98_517 average
    expect(r.totalReturn.lt(0)).toBe(true);
  });

  // S3: initial buy + TP — one complete profitable cycle
  //
  // C0 100k: initCycle
  // C1 97999: L0 fills → qty=0.00145, avgEntry=98_517.24, tpPrice=99_995.00
  // C2 99999: 99_999 ≥ 99_995 → TP fires
  //   revenue = 0.00145 × 99_995 = 144.99 (ROUND_DOWN)
  //   profit  = 144.99 − 142.85 = 2.14
  it("S3: initial buy only + TP cycle → realizedPnl = 2.14", () => {
    const candles = [flat(100_000), flat(97_999), flat(99_999)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(2); // 1 buy + 1 sell
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("2.14");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[INITIAL]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S4: initial buy + 1 safety order + TP
  //
  // C0 100k: initCycle
  // C1 96039: 96_039 ≤ 98_000 → L0 fills; 96_039 ≤ 96_040 → L1 fills; 96_039 > 94_119 → L2 not filled
  //   totalQty=0.00442, totalCost=428.56
  //   avgEntry = 428.56 / 0.00442 = 96_959.276...
  //   tpPrice  = 96_959.276 × 1.015 = 98_413.67 (ROUND_UP)
  // C2 98415: 98_415 ≥ 98_413.67 → TP fires
  //   revenue = 0.00442 × 98_413.67 = 434.98 (ROUND_DOWN)
  //   profit  = 434.98 − 428.56 = 6.42
  it("S4: initial buy + 1 safety order + TP → realizedPnl = 6.42", () => {
    const candles = [flat(100_000), flat(96_039), flat(98_415)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(3); // 2 buys + 1 sell
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("6.42");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[SO#1]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S5: all safety orders filled + TP — maximum position, highest profit
  //
  // C0 100k: initCycle
  // C1 94118: 94_118 ≤ 98_000 → L0; ≤ 96_040 → L1; ≤ 94_119.20 → L2
  //   totalQty=0.01049, totalCost=999.98
  //   avgEntry = 999.98 / 0.01049 = 95_326.978...
  //   tpPrice  = 95_326.978 × 1.015 = 96_756.89 (ROUND_UP)
  // C2 96758: 96_758 ≥ 96_756.89 → TP fires
  //   revenue = 0.01049 × 96_756.89 = 1014.97 (ROUND_DOWN)
  //   profit  = 1014.97 − 999.98 = 14.99
  it("S5: all safety orders filled + TP → realizedPnl = 14.99", () => {
    const candles = [flat(100_000), flat(94_118), flat(96_758)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(4); // 3 buys + 1 sell
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("14.99");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[SO#1]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[SO#2]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S6: stop-loss fires after all levels fill
  //
  // C0 100k: initCycle → slPrice = 100_000 × 0.85 = 85_000
  // C1 97999: L0 fills (97_999 ≤ 98_000; 97_999 > 96_040 so L1 not filled)
  // C2 84999: bullish → runBuys first: L1 fills, L2 fills
  //   then runSells: 84_999 ≤ slPrice=85_000 → STOP-LOSS
  //   totalQty=0.01049, totalCost=999.98
  //   revenue = 0.01049 × 85_000 = 891.65 (ROUND_DOWN)
  //   profit  = 891.65 − 999.98 = −108.33
  //   stopped = true (no further candles processed)
  it("S6: stop-loss fires → realizedPnl = −108.33, stopped", () => {
    const candles = [
      flat(100_000),
      flat(97_999),
      flat(84_999),
      flat(99_999), // this candle must NOT be processed (stopped=true)
    ];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.stopLossCount).toBe(1);
    expect(r.completedCycles).toBe(1); // SL counts as a completed cycle
    expect(r.winningCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("-108.33");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[STOP-LOSS]"))).toBe(true);
    // Verify the 4th candle (flat 99_999) was NOT processed:
    // if it were, completedCycles would be 2 (a new cycle would TP)
    expect(r.completedCycles).toBe(1);
  });

  // S7: two consecutive TP cycles
  //
  // Cycle 1:
  //   C0 100k: initCycle(100k)  → L0 at 98_000
  //   C1 97999: L0 fills → qty=0.00145, tpPrice=99_995
  //   C2 99999: TP fires → profit=2.14; new cycle initiated at close=99_999
  //             → new L0 = 99_999 × 0.98 = 97_999.02
  //
  // Cycle 2:
  //   C3 97999: 97_999 ≤ 97_999.02 → new L0 fills; qty=0.00145, tpPrice=99_995
  //   C4 99999: TP fires → profit=2.14
  //
  // Total realizedPnl = 2.14 + 2.14 = 4.28
  it("S7: two TP cycles → realizedPnl = 4.28, completedCycles = 2", () => {
    const candles = [
      flat(100_000),
      flat(97_999),
      flat(99_999),
      flat(97_999),
      flat(99_999),
    ];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.completedCycles).toBe(2);
    expect(r.winningCycles).toBe(2);
    expect(r.stopLossCount).toBe(0);
    expect(r.totalTrades).toBe(4); // 2 buys + 2 sells
    expect(r.realizedPnl.toFixed(2)).toBe("4.28");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.filter((l) => l.includes("[TP]")).length).toBe(2);
  });

  // S8: unrealized P&L — position open at end of data
  //
  // C0 100k: initCycle
  // C1 97999: L0 fills → qty=0.00145, cost=142.85 — no TP (price below tpPrice=99_995)
  //
  // End of data: finalBase=0.00145, finalCost=142.85
  // finalUnrealized = 0.00145 × 97_999 − 142.85 = 142.09855 − 142.85 = −0.75145
  // totalReturn = 0 + (−0.75145) = −0.75145
  it("S8: open position at end — unrealized P&L flows into totalReturn", () => {
    const candles = [flat(100_000), flat(97_999)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.toFixed(5)).toBe("0.00145");
    // unrealized = 0.00145 × 97_999 − 142.85
    const expectedUnrealized = d("0.00145").times(97_999).minus("142.85");
    expect(r.totalReturn.toFixed(5)).toBe(expectedUnrealized.toFixed(5));
    expect(r.totalReturn.lt(0)).toBe(true);
  });
});
