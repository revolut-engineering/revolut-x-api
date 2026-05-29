import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runBacktest,
  type BacktestFill,
} from "../../src/shared/backtest/engine.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function d(n: number | string) {
  return new Decimal(n);
}

function flat(price: number) {
  const p = d(price);
  return { open: p, high: p, low: p, close: p };
}

const LEVELS = 6;
const RANGE = d("0.05");
const INVEST = d(1_000);

// Grid (startPrice=100k, 6 levels, ±5%):
//   L0≈95k, L1≈96.9k, L2≈98.9k (buy levels, price < 100k)
//   L3≈100.9k, L4≈102.9k, L5≈105k (above start)
// Split init: L2.positions=[bp], L3.positions=[bp], L4.positions=[bp]; L2.buyCount stays 1.
// Trailing-up threshold ≈ 108.2k.

function collectFills(
  candles: ReturnType<typeof flat>[],
  split = false,
  trailingUp = false,
  stopLoss = 0,
): { result: ReturnType<typeof runBacktest>; tickFills: BacktestFill[][] } {
  const tickFills: BacktestFill[][] = [];
  const result = runBacktest(
    candles,
    LEVELS,
    RANGE,
    INVEST,
    split,
    trailingUp,
    stopLoss,
    (ev) => tickFills.push([...ev.fills]),
  );
  return { result, tickFills };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Grid bot scenarios (runBacktest)", () => {
  // 2.1: baseline — no extras, simple buy/sell cycle
  //
  // C1 88k: 3 buys (L0, L1, L2 all reached).
  // C2 101k: all 3 positions sell (L0→L1, L1→L2, L2→L3 all reached).
  it("2.1: baseline (no split, no SL, no TU): 3 buys then 3 sells", () => {
    const candles = [flat(100_000), flat(88_000), flat(101_000)];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST);

    expect(r.totalBuys).toBe(3);
    expect(r.totalSells).toBe(3);
    expect(r.realizedPnl.toFixed(2)).toBe("18.34");
    expect(r.stopLossTriggered).toBe(false);
    expect(r.trailingUpShifts).toBe(0);
  });

  // 2.2: split — buyCount accumulates when 2 positions sell from same level
  //
  // Candles: [100k, 98.5k, 101k, 98.5k, 101k]
  // C0 100k:  split init (L2.positions=[bp], L2.buyCount=1 preserved)
  // C1 98.5k: 1 buy at L2 → L2.positions=[split_pos, new_pos]; L2.buyCount cleared
  // C2 101k:  both L2 positions sell at L3 → 2 sells; L2.buyCount=2
  // C3 98.5k: L2.buyCount=2 → inner loop fires twice → 2 buys; L2.positions=[p1,p2]
  // C4 101k:  both positions sell at L3 again → 2 sells; L2.buyCount=2
  //
  // The per-tick fill counts prove the buyCount doubling mechanism works.
  it("2.2: split — buyCount doubles; both orders execute and re-establish", () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(98_500),
      flat(101_000),
    ];
    const { result: r, tickFills } = collectFills(candles, true);

    expect(tickFills[1].filter((f) => f.side === "buy").length).toBe(1);
    expect(tickFills[2].filter((f) => f.side === "sell").length).toBe(2);
    expect(tickFills[3].filter((f) => f.side === "buy").length).toBe(2);
    expect(tickFills[4].filter((f) => f.side === "sell").length).toBe(2);

    expect(r.totalBuys).toBe(3); // 1 (C1) + 2 (C3)
    expect(r.totalSells).toBe(4); // 2 (C2) + 2 (C4)
    expect(r.realizedPnl.toFixed(2)).toBe("9.23");
    expect(r.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);
  });

  // 2.3: stop-loss only — fires after buys, clears all positions
  //
  // C1 88k: 3 buys; C2 80k: 80k ≤ SL=82k → SL fires, 3 SL sells.
  it("2.3: stop-loss only: fires after buys, clears all positions", () => {
    const candles = [flat(100_000), flat(88_000), flat(80_000)];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST, false, false, 82_000);

    expect(r.totalBuys).toBe(3);
    expect(r.stopLossTriggered).toBe(true);
    expect(r.totalSells).toBe(3);
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.realizedPnl.toFixed(2)).toBe("-155.39");
    expect(r.tradeLog.some((l) => l.includes("STOP-LOSS"))).toBe(true);
    expect(r.trailingUpShifts).toBe(0);
  });

  // 2.4: trailing-up + split — savedBuyCounts=[1,1,2,1,1,0] preserved across rebuild
  //
  // Candles: [100k, 98.5k, 101k, 103k, 105k, 120k, 108k]
  // After C1-C4: buyCounts=[1,1,2,1,1,0] (L2 doubled because 2 positions sold).
  // C5 120k:  TU fires (split k=7); grid shifts up; 5 levels end up below 120k;
  //           buyCounts restored from savedBuyCounts; trailingUpShifts=1.
  //           No TU-trigger fills (no positions held at TU time).
  // C6 108k:  108k ≤ all 5 new levels → 1+1+2+1+1=6 buys (proves k=7 applied).
  //
  // totalBuys=7, totalSells=4, trailingUpShifts=1
  it("2.4: trailing-up + split: big jump preserves accumulated buyCounts, 6 buys after rebuild", () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(105_000),
      flat(120_000),
      flat(108_000),
    ];
    const { result: r, tickFills } = collectFills(candles, true, true, 0);

    expect(tickFills[5].filter((f) => f.trigger === "trailing-up").length).toBe(0);
    expect(tickFills[6].filter((f) => f.side === "buy").length).toBe(6);

    expect(r.totalBuys).toBe(7);
    expect(r.totalSells).toBe(4);
    expect(r.realizedPnl.toFixed(2)).toBe("15.43");
    expect(r.trailingUpShifts).toBe(1);
    expect(r.stopLossTriggered).toBe(false);
    expect(r.tradeLog.some((l) => l.includes("TRAILING UP:"))).toBe(true);
  });

  // 2.5: split + stop-loss — split sells happen first, then SL fires on drop
  //
  // C1 103k: 2 split sells (L2→L3, L3→L4); L2.buyCount=2, L3.buyCount=1
  // C2 88k:  1+1+2+1 = 5 buys (L0,L1,L2×2,L3; L4.buyCount=0)
  // C3 80k:  SL fires → 5+1(L4 split) = 6 SL sells; finalBase=0
  it("2.5: split + stop-loss: split sells happen, then SL fires on drop", () => {
    const candles = [flat(100_000), flat(103_000), flat(88_000), flat(80_000)];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST, true, false, 82_000);

    expect(r.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);
    expect(r.stopLossTriggered).toBe(true);
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.realizedPnl.toFixed(2)).toBe("-164.32");
    expect(r.tradeLog.some((l) => l.includes("STOP-LOSS"))).toBe(true);
    expect(r.trailingUpShifts).toBe(0);
    expect(r.totalSells).toBeGreaterThan(2);
  });

  // 2.6: split + trailing-up — verify both features activate in sequence
  it("2.6: split + trailing-up: TU fires after price path, grid rebuilds", () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(105_000),
      flat(120_000),
      flat(108_000),
    ];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST, true, true, 0);

    expect(r.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);
    expect(r.trailingUpShifts).toBe(1);
    expect(r.stopLossTriggered).toBe(false);
    expect(r.realizedPnl.toFixed(2)).toBe("15.43");
    expect(r.tradeLog.some((l) => l.includes("TRAILING UP:"))).toBe(true);
    expect(r.totalBuys).toBeGreaterThan(0);
  });

  // 2.7: stop-loss + trailing-up — SL price stays fixed at 82k even after grid shifts to ~120k
  //
  // C1 88k:  3 buys; C2 101k: 3 sells; C3 120k: TU fires, grid shifts up, trailingUpShifts=1;
  // C4 108k: 3 buys at new levels; C5 80k: 80k ≤ SL=82k → SL fires, finalBase=0.
  it("2.7: stop-loss + trailing-up: SL price is fixed even after TU rebuild", () => {
    const candles = [
      flat(100_000),
      flat(88_000),
      flat(101_000),
      flat(120_000),
      flat(108_000),
      flat(80_000),
    ];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST, false, true, 82_000);

    expect(r.trailingUpShifts).toBe(1);
    expect(r.stopLossTriggered).toBe(true);
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.realizedPnl.toFixed(2)).toBe("-275.63");
    expect(r.tradeLog.some((l) => l.includes("TRAILING UP:"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("STOP-LOSS"))).toBe(true);
  });

  // 2.8: all three features — split + stop-loss + trailing-up all activate
  //
  // C1 103k: 2 split sells; C2 120k: TU fires (trailingUpShifts=1); C3 108k: 6 buys;
  // C4 80k:  SL fires → all 6 positions liquidated; finalBase=0.
  it("2.8: all features (split + SL + TU): all three activate in sequence", () => {
    const candles = [
      flat(100_000),
      flat(103_000),
      flat(120_000),
      flat(108_000),
      flat(80_000),
    ];
    const r = runBacktest(candles, LEVELS, RANGE, INVEST, true, true, 82_000);

    expect(r.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);
    expect(r.trailingUpShifts).toBe(1);
    expect(r.stopLossTriggered).toBe(true);
    expect(r.finalBase.isZero()).toBe(true);
    expect(r.realizedPnl.toFixed(2)).toBe("-269.02");
    expect(r.tradeLog.some((l) => l.includes("TRAILING UP:"))).toBe(true);
    expect(r.tradeLog.some((l) => l.includes("STOP-LOSS"))).toBe(true);
  });
});
