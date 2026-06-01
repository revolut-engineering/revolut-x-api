import { describe, it, expect, vi } from "vitest";
import { Decimal } from "decimal.js";
import {
  runBacktest,
  runBacktestBot,
  optimizeGridParams,
} from "../../src/shared/backtest/engine.js";
import {
  runBacktest as runBacktestMcp,
  optimizeGridParams as optimizeGridParamsMcp,
} from "../../../mcp/src/shared/backtest/index.js";

// ── Mocks required for runBacktestBot (drives ForegroundGridBot) ──────────────

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  class InsecureKeyPermissionsError extends Error {
    constructor(msg = "insecure key") {
      super(msg);
      this.name = "InsecureKeyPermissionsError";
    }
  }
  return {
    ...actual,
    InsecureKeyPermissionsError,
    RevolutXClient: vi
      .fn()
      .mockImplementation(() => ({ isAuthenticated: true })),
    getConfigDir: () => "/tmp/revx-v2-consistency-test",
    ensureConfigDir: vi.fn(),
  };
});

vi.mock("../../src/db/store.js", () => ({ loadConnections: vi.fn(() => []) }));

vi.mock("../../src/engine/notify.js", () => ({
  sendWithRetries: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock("../../src/db/grid-store.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveGridState: vi.fn(),
    loadGridState: vi.fn(() => null),
    deleteGridState: vi.fn(),
  };
});

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

// ── A — runBacktest ↔ runBacktestBot consistency (flat candles) ───────────────
//
// Flat candles make both engines equivalent: flat(price) means open=high=low=close=price,
// so runBacktest fill conditions (low ≤ level, high ≥ sellLevel) and runBacktestBot
// fill conditions (close ≤ buy order, close ≥ sell order) both trigger on the same candle.
//
// Grid config: startPrice=100_000, 6 levels, ±5% range, 1_000 investment.
// Levels: L0≈95k, L1≈96.9k, L2≈98.9k, L3≈100.9k, L4≈102.9k, L5≈105k.
// Buy levels (price < startPrice): L0, L1, L2.
// Split sell levels (price > startPrice): L3 (sells at L4), L4 (sells at L5).
// Split positions land at: L2 (for sellIdx=3), L3 (for sellIdx=4), L4 (for sellIdx=5).

describe("A — runBacktest ↔ runBacktestBot consistency (flat candles)", () => {
  // A.1: split + rich price path
  //
  // Candles:  [100k, 98.5k, 101k, 103k, 100k, 93k]
  // C0 100k:  split init, 0 grid trades
  // C1 98.5k: 98.5k ≤ L2(98.9k) → 1 buy; L2.positions=[split_pos, new_pos]
  // C2 101k:  both L2 positions sell at L3(100.9k) → 2 sells; L2.buyCount=2
  // C3 103k:  L3 split_pos sells at L4(102.9k) → 1 sell; L3.buyCount=1
  // C4 100k:  L3.buyCount=1, 100k ≤ L3(100.9k) → 1 buy
  // C5 93k:   L0(1)+L1(1)+L2(buyCount=2) → 4 buys
  //
  // totalBuys=6, totalSells=3
  it("A.1: split + rich path: both engines produce same trade counts", async () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(100_000),
      flat(93_000),
    ];
    const bt = runBacktest(candles, LEVELS, RANGE, INVEST, true, false, 0);
    const bot = await runBacktestBot(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      true,
      false,
      0,
    );

    expect(bt.totalBuys).toBe(6);
    expect(bt.totalSells).toBe(3);
    expect(bt.stopLossTriggered).toBe(false);
    expect(bt.trailingUpShifts).toBe(0);
    expect(bt.realizedPnl.gt(0)).toBe(true);
    expect(bt.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);

    expect(bot.totalBuys).toBe(bt.totalBuys);
    expect(bot.totalSells).toBe(bt.totalSells);
    expect(bot.stopLossTriggered).toBe(bt.stopLossTriggered);
    expect(bot.trailingUpShifts).toBe(bt.trailingUpShifts);
  });

  // A.2: stop-loss fires on same candle
  //
  // C1 88k: 3 buys (L0, L1, L2); C2 80k: 80k ≤ SL=82k → SL fires.
  // runBacktest counts 3 individual SL sells; runBacktestBot fires _triggerStopLoss
  // which liquidates all positions as one aggregate order → bot.totalSells=1.
  // The meaningful consistency check is that both engines flag stopLossTriggered on
  // the same candle and agree on pre-SL buy count.
  it("A.2: stop-loss: both engines trigger on same candle", async () => {
    const candles = [flat(100_000), flat(88_000), flat(80_000)];
    const SL = 82_000;
    const bt = runBacktest(candles, LEVELS, RANGE, INVEST, false, false, SL);
    const bot = await runBacktestBot(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      false,
      false,
      SL,
    );

    expect(bt.stopLossTriggered).toBe(true);
    expect(bt.totalBuys).toBe(3);
    expect(bt.totalSells).toBe(3);
    expect(bt.finalBase.isZero()).toBe(true);

    expect(bot.stopLossTriggered).toBe(true);
    expect(bot.totalBuys).toBe(bt.totalBuys);
    expect(bot.totalSells).toBeGreaterThan(0);
  });

  // A.3: stop-loss does NOT fire when price stays above threshold
  it("A.3: stop-loss: does not trigger when price stays above threshold", async () => {
    const candles = [flat(100_000), flat(88_000)];
    const bt = runBacktest(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      false,
      false,
      82_000,
    );
    const bot = await runBacktestBot(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      false,
      false,
      82_000,
    );

    expect(bt.stopLossTriggered).toBe(false);
    expect(bt.totalBuys).toBeGreaterThan(0);

    expect(bot.stopLossTriggered).toBe(false);
    expect(bot.totalBuys).toBe(bt.totalBuys);
  });

  // A.4: trailing-up big jump, split mode — savedBuyCounts=[1,1,2,1,1,0] preserved
  //
  // Candles: [100k, 98.5k, 101k, 103k, 105k, 120k, 108k]
  // C1 98.5k: 1 buy at L2; L2.positions=[split_pos, new_pos]
  // C2 101k:  both L2 positions sell at L3 → 2 sells; L2.buyCount=2
  // C3 103k:  L3 split_pos sells at L4 → 1 sell; L3.buyCount=1
  // C4 105k:  L4 split_pos sells at L5 → 1 sell; L4.buyCount=1
  // After C4: buyCounts=[1,1,2,1,1,0]
  // C5 120k:  TU threshold≈108.2k exceeded; split k=7 → all 5 new levels below 120k
  //           → buyCounts restored from savedBuyCounts=[1,1,2,1,1,0]; trailingUpShifts=1
  // C6 108k:  all 5 levels' buyCounts fire: 1+1+2+1+1=6 buys → proves k=7 and counts preserved
  //
  // totalBuys=7, totalSells=4, trailingUpShifts=1
  it("A.4: trailing-up big jump: both engines apply multi-step shift and preserve buyCounts", async () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(105_000),
      flat(120_000),
      flat(108_000),
    ];
    const bt = runBacktest(candles, LEVELS, RANGE, INVEST, true, true, 0);
    const bot = await runBacktestBot(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      true,
      true,
      0,
    );

    expect(bt.totalBuys).toBe(7);
    expect(bt.totalSells).toBe(4);
    expect(bt.trailingUpShifts).toBe(1);
    expect(bt.stopLossTriggered).toBe(false);

    expect(bot.totalBuys).toBe(bt.totalBuys);
    expect(bot.totalSells).toBe(bt.totalSells);
    expect(bot.trailingUpShifts).toBe(bt.trailingUpShifts);
    expect(bot.stopLossTriggered).toBe(bt.stopLossTriggered);
  });

  // A.5: split basic — init positions sell on first upward move
  //
  // C1 104k: L2→L3 and L3→L4 both reached → 2 sells from split init positions.
  it("A.5: split basic: both engines produce sells from split init positions", async () => {
    const candles = [flat(100_000), flat(104_000)];
    const bt = runBacktest(candles, LEVELS, RANGE, INVEST, true, false, 0);
    const bot = await runBacktestBot(
      candles,
      LEVELS,
      RANGE,
      INVEST,
      true,
      false,
      0,
    );

    expect(bt.totalSells).toBe(2);
    expect(bt.realizedPnl.gt(0)).toBe(true);
    expect(bt.tradeLog.some((l) => l.startsWith("SPLIT:"))).toBe(true);

    expect(bot.totalSells).toBe(bt.totalSells);
    expect(bot.realizedPnl.gt(0)).toBe(true);
  });
});

// ── B — CLI runBacktest ↔ MCP runBacktest (byte-level equality) ───────────────

describe("B — CLI runBacktest ↔ MCP runBacktest (exact equality)", () => {
  const candles = [
    flat(100_000),
    flat(98_500),
    flat(101_000),
    flat(103_000),
    flat(100_000),
    flat(93_000),
  ];

  it("B.1: identical trade counts, P&L, and flags", () => {
    const cli = runBacktest(candles, LEVELS, RANGE, INVEST, true, false, 0);
    const mcp = runBacktestMcp(candles, LEVELS, RANGE, INVEST, true, false, 0);

    expect(cli.totalBuys).toBe(mcp.totalBuys);
    expect(cli.totalSells).toBe(mcp.totalSells);
    expect(cli.totalTrades).toBe(mcp.totalTrades);
    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.finalBase.eq(mcp.finalBase)).toBe(true);
    expect(cli.finalQuote.eq(mcp.finalQuote)).toBe(true);
    expect(cli.stopLossTriggered).toBe(mcp.stopLossTriggered);
    expect(cli.trailingUpShifts).toBe(mcp.trailingUpShifts);
  });

  it("B.2: optimizeGridParams returns identical top result", () => {
    const ranges = [d("0.05"), d("0.08")];
    const levelsList = [6, 8];
    const cliResults = optimizeGridParams(
      candles,
      levelsList,
      ranges,
      INVEST,
      1,
    );
    const mcpResults = optimizeGridParamsMcp(
      candles,
      levelsList,
      ranges,
      INVEST,
      1,
    );

    expect(cliResults.length).toBe(mcpResults.length);
    if (cliResults.length > 0) {
      expect(cliResults[0].gridLevels).toBe(mcpResults[0].gridLevels);
      expect(cliResults[0].rangePct.eq(mcpResults[0].rangePct)).toBe(true);
      expect(cliResults[0].totalReturn.eq(mcpResults[0].totalReturn)).toBe(
        true,
      );
      expect(cliResults[0].totalTrades).toBe(mcpResults[0].totalTrades);
    }
  });
});

// ── C — runBacktest ↔ optimizeGridParams internal consistency ─────────────────

describe("C — runBacktest ↔ optimizeGridParams consistency", () => {
  // optimizeGridParams calls runBacktest internally and computes:
  //   totalReturn = finalQuote + finalBase * finalPrice - investment
  // This test verifies that single-combo optimize produces exactly the same
  // realizedPnl, totalTrades, and totalReturn as a direct runBacktest call.
  it("C.1: single-combo optimize entry matches direct runBacktest for same params", () => {
    const candles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(100_000),
      flat(93_000),
    ];
    const results = optimizeGridParams(candles, [LEVELS], [RANGE], INVEST, 1);
    expect(results).toHaveLength(1);

    const opt = results[0];
    const bt = runBacktest(candles, LEVELS, RANGE, INVEST);
    const finalPrice = candles[candles.length - 1].close;
    const computedTotalReturn = bt.finalQuote
      .plus(bt.finalBase.times(finalPrice))
      .minus(INVEST);

    expect(opt.realizedPnl.eq(bt.realizedPnl)).toBe(true);
    expect(opt.totalTrades).toBe(bt.totalTrades);
    expect(opt.totalReturn.eq(computedTotalReturn)).toBe(true);
  });
});
