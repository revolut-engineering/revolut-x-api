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
// dev=2%, scale=2, maxSO=2 → 3 levels total (L0 = market entry, L1/L2 = safety orders)
// TP=1.5%, SL=15%, investment=1000
//
// basePct = (2−1)/(2^3−1) = 1/7
//
// Level prices (from entryPrice=100_000):
//   L0 (market entry) = 100_000                  quoteSize = 142.85
//   L1 (SO#1 limit)   = 100_000 × 0.98^1 = 98_000   quoteSize = 285.71
//   L2 (SO#2 limit)   = 100_000 × 0.98^2 = 96_040   quoteSize = 571.42
//
// Market entry fills immediately at cycle start:
//   qty_L0 = 142.85 / 100_000 = 0.00142  (ROUND_DOWN 5dp)
//   avgEntry = 142.85 / 0.00142 = 100_598.59...
//   tpPrice  = 100_598.59 × 1.015 = 102_107.58  (ROUND_UP 2dp)
//
// After SO#1 fills at 98_000:
//   qty_SO1 = 285.71 / 98_000 = 0.00291
//   totalQty = 0.00433,  totalCost = 428.56
//   avgEntry = 98_974.60,  tpPrice = 100_459.22  (ROUND_UP 2dp)
//
// After SO#1 + SO#2 fill at 96_040:
//   qty_SO2 = 571.42 / 96_040 = 0.00594
//   totalQty = 0.01027,  totalCost = 999.98
//   avgEntry = 97_369.04,  tpPrice = 98_829.58  (ROUND_UP 2dp)
//
// SL price = 100_000 × 0.85 = 85_000.00
//
// TP revenues (qty × tpPrice, ROUND_DOWN 2dp) and profits:
//   L0 only:        0.00142 × 102_107.58 = 144.99 → profit = 144.99 − 142.85 = 2.14
//   L0+SO#1:        0.00433 × 100_459.22 = 434.98 → profit = 434.98 − 428.56 = 6.42
//   L0+SO#1+SO#2:   0.01027 × 98_829.58  = 1_014.97 → profit = 1_014.97 − 999.98 = 14.99
//
// SL after market entry + both SOs fill:
//   revenue = 0.01027 × 85_000 = 872.95 → profit = 872.95 − 999.98 = −127.03

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
  // S1: market entry fires at cycle start; price never reaches SO levels or TP
  //
  // Before loop: market entry at 100_000 → qty=0.00142, tpPrice=102_107.58
  // C0 100k: no fills, no sell
  // C1 99k:  99_000 > 98_000 → SO#1 not triggered; 99_000 < 102_107.58 → no TP
  it("S1: market entry only — no safety orders, no TP", () => {
    const candles = [flat(100_000), flat(99_000)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(1); // market entry only
    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.toFixed(5)).toBe("0.00142");
    expect(r.finalCost.toFixed(2)).toBe("142.85");
    expect(r.stopLossCount).toBe(0);
  });

  // S2: market entry fills; price drops to SO#1 level — SO#1 fills, no TP by end of data
  //
  // Before loop: market entry at 100_000
  // C0 100k: no fills, no sell
  // C1 97999: 97_999 ≤ 98_000 → SO#1 fills; 97_999 < 100_459.22 → no TP
  it("S2: market entry + SO#1 fills, no TP — partial position at end", () => {
    const candles = [flat(100_000), flat(97_999)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(2); // entry + SO#1
    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.toFixed(5)).toBe("0.00433");
    expect(r.finalCost.toFixed(2)).toBe("428.56");
    // position is underwater at close=97_999 vs avgEntry≈98_974
    expect(r.totalReturn.lt(0)).toBe(true);
  });

  // S3: market entry + TP without any safety orders — one profitable cycle
  //
  // Before loop: market entry at 100_000 → tpPrice=102_107.58
  // C0 100k: no fills, no sell
  // C1 102108: 102_108 ≥ 102_107.58 → TP fires
  //   revenue = 0.00142 × 102_107.58 = 144.99 (ROUND_DOWN)
  //   profit  = 144.99 − 142.85 = 2.14
  //   new cycle at close=102_108 → immediate market entry (trade #3)
  it("S3: market entry + TP (no safety orders) → realizedPnl = 2.14", () => {
    const candles = [flat(100_000), flat(102_108)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(3); // entry + TP sell + new-cycle entry
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("2.14");
    expect(r.tradeLog.some((l) => l.includes("[ENTRY]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S4: market entry + SO#1 + TP
  //
  // Before loop: market entry at 100_000 → tpPrice=102_107.58
  // C0 100k: no fills, no sell
  // C1 97999: SO#1 fills at 98_000 → tpPrice → 100_459.22
  // C2 100460: 100_460 ≥ 100_459.22 → TP fires
  //   revenue = 0.00433 × 100_459.22 = 434.98 (ROUND_DOWN)
  //   profit  = 434.98 − 428.56 = 6.42
  //   new cycle at close=100_460 → immediate market entry (trade #4)
  it("S4: market entry + SO#1 + TP → realizedPnl = 6.42", () => {
    const candles = [flat(100_000), flat(97_999), flat(100_460)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(4); // entry + SO#1 + TP sell + new-cycle entry
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("6.42");
    expect(r.tradeLog.some((l) => l.includes("[SO#1]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S5: market entry + both safety orders + TP — maximum position, highest profit
  //
  // Before loop: market entry at 100_000 → tpPrice=102_107.58
  // C0 100k: no fills, no sell
  // C1 95999: 95_999 ≤ 98_000 → SO#1; 95_999 ≤ 96_040 → SO#2; tpPrice → 98_829.58
  // C2 98830: 98_830 ≥ 98_829.58 → TP fires
  //   revenue = 0.01027 × 98_829.58 = 1_014.97 (ROUND_DOWN)
  //   profit  = 1_014.97 − 999.98 = 14.99
  //   new cycle at close=98_830 → immediate market entry (trade #5)
  it("S5: market entry + both safety orders + TP → realizedPnl = 14.99", () => {
    const candles = [flat(100_000), flat(95_999), flat(98_830)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.totalTrades).toBe(5); // entry + SO#1 + SO#2 + TP sell + new-cycle entry
    expect(r.completedCycles).toBe(1);
    expect(r.winningCycles).toBe(1);
    expect(r.stopLossCount).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("14.99");
    expect(r.tradeLog.some((l) => l.includes("[SO#1]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[SO#2]"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[TP]"))).toBe(true);
  });

  // S6: stop-loss fires after market entry + both safety orders fill on same candle
  //
  // SL price = 100_000 × 0.85 = 85_000
  // Before loop: market entry at 100_000
  // C0 100k: no fills, no sell
  // C1 84999: flat (not bearish) → runBuys first: SO#1 fills, SO#2 fills
  //           then runSells: 84_999 ≤ 85_000 → STOP-LOSS
  //   totalQty=0.01027, totalCost=999.98
  //   revenue = 0.01027 × 85_000 = 872.95 (ROUND_DOWN)
  //   profit  = 872.95 − 999.98 = −127.03
  //   stopped = true — C2 (99_999) must NOT be processed
  it("S6: stop-loss fires → realizedPnl = −127.03, stopped", () => {
    const candles = [
      flat(100_000),
      flat(84_999),
      flat(99_999), // this candle must NOT be processed (stopped=true)
    ];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.stopLossCount).toBe(1);
    expect(r.completedCycles).toBe(1); // SL counts as a completed cycle
    expect(r.winningCycles).toBe(0);
    expect(r.totalTrades).toBe(4); // entry + SO#1 + SO#2 + SL sell
    expect(r.realizedPnl.toFixed(2)).toBe("-127.03");
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("[STOP-LOSS]"))).toBe(true);
    // Verify the 3rd candle (flat 99_999) was NOT processed:
    // if it were, completedCycles would be > 1
    expect(r.completedCycles).toBe(1);
  });

  // S7: two consecutive TP cycles (market entry only, no safety orders)
  //
  // Cycle 1:
  //   Before loop: market entry at 100_000 → tpPrice=102_107.58
  //   C1 102108: TP fires → profit=2.14
  //              new cycle at close=102_108 → market entry at 102_108
  //
  // Cycle 2 (entry at 102_108):
  //   qty=0.00139, avgEntry=102_769.78, tpPrice=104_311.34
  //   C2 104312: 104_312 ≥ 104_311.34 → TP fires → profit=2.14
  //              new cycle at close=104_312 → market entry (trade #5)
  //
  // Total realizedPnl = 2.14 + 2.14 = 4.28
  // Total trades = 5: entry@100k + sell + entry@102108 + sell + entry@104312
  it("S7: two TP cycles → realizedPnl = 4.28, completedCycles = 2", () => {
    const candles = [flat(100_000), flat(102_108), flat(104_312)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.completedCycles).toBe(2);
    expect(r.winningCycles).toBe(2);
    expect(r.stopLossCount).toBe(0);
    expect(r.totalTrades).toBe(5); // 2 entries (cycle 1,2) + 2 TP sells + 1 entry (cycle 3 pending)
    expect(r.realizedPnl.toFixed(2)).toBe("4.28");
    expect(r.tradeLog.filter((l) => l.includes("[TP]")).length).toBe(2);
  });

  // S8: unrealized P&L — position open at end of data
  //
  // Before loop: market entry at 100_000 → qty=0.00142
  // C0 100k: no fills, no sell
  // C1 97999: SO#1 fills → qty=0.00433, cost=428.56 — no TP (97_999 < 100_459.22)
  //
  // End of data: finalBase=0.00433, finalCost=428.56
  // finalUnrealized = 0.00433 × 97_999 − 428.56
  // totalReturn = 0 + finalUnrealized
  it("S8: open position at end — unrealized P&L flows into totalReturn", () => {
    const candles = [flat(100_000), flat(97_999)];
    const r = runMartingaleBacktest(candles, PARAMS);

    expect(r.completedCycles).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
    expect(r.finalBase.toFixed(5)).toBe("0.00433");
    // unrealized = 0.00433 × 97_999 − 428.56
    const expectedUnrealized = d("0.00433").times(97_999).minus("428.56");
    expect(r.totalReturn.toFixed(5)).toBe(expectedUnrealized.toFixed(5));
    expect(r.totalReturn.lt(0)).toBe(true);
  });
});
