import { describe, it, expect, vi } from "vitest";
import { Decimal } from "decimal.js";
import {
  annualizedReturnPct,
  candleCoverage,
  runBacktest,
  runBacktestBot,
  optimizeGridParams,
} from "../../src/shared/backtest/engine.js";
import { quotePerLevelFor } from "../../src/engine/grid-plan.js";
import {
  annualizedReturnPct as annualizedReturnPctMcp,
  candleCoverage as candleCoverageMcp,
  quotePerLevelFor as quotePerLevelForMcp,
  runBacktest as runBacktestMcp,
  optimizeGridParams as optimizeGridParamsMcp,
} from "../../../mcp/src/shared/backtest/index.js";
import { trailUpTriggerPrice } from "../../src/engine/grid-math.js";

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

function at(p: Decimal) {
  return { open: p, high: p, low: p, close: p };
}

const TRAIL_UP_LADDER = [
  "95000",
  "96920.75",
  "98880.32",
  "100879.52",
  "102919.14",
  "105000",
].map((price, index) => ({ index, price, buyOrderIds: [], positions: [] }));

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
  // runBacktest counts 3 individual SL sells; runBacktestBot runs the bot's
  // liquidation, which sells all positions as one aggregate order → bot.totalSells=1.
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
    expect(bot.trades.some((trade) => trade.trigger === "stop-loss")).toBe(
      true,
    );
    expect(bot.finalBase.isZero()).toBe(true);
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

  it("trailing-up fires exactly at trailUpTriggerPrice, not before", async () => {
    const trigger = trailUpTriggerPrice(TRAIL_UP_LADDER);
    expect(trigger).not.toBeNull();
    expect(trigger!.toFixed(2)).toBe("109288.78");

    const below = await runBacktestBot(
      [flat(100_000), at(trigger!.minus("0.01"))],
      LEVELS,
      RANGE,
      INVEST,
      false,
      true,
      0,
    );
    expect(below.trailingUpShifts).toBe(0);

    const atTrigger = await runBacktestBot(
      [flat(100_000), at(trigger!)],
      LEVELS,
      RANGE,
      INVEST,
      false,
      true,
      0,
    );
    expect(atTrigger.trailingUpShifts).toBe(1);
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
    const cliResults = optimizeGridParams(candles, levelsList, ranges, INVEST, {
      days: 1,
      intervalDays: 1 / 24,
    });
    const mcpResults = optimizeGridParamsMcp(
      candles,
      levelsList,
      ranges,
      INVEST,
      { days: 1, intervalDays: 1 / 24 },
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

  it("both engines cross the trail-up threshold at the same price", () => {
    const trigger = trailUpTriggerPrice(TRAIL_UP_LADDER)!;

    const below = [flat(100_000), at(trigger.minus("0.01"))];
    const cliBelow = runBacktest(below, LEVELS, RANGE, INVEST, false, true, 0);
    const mcpBelow = runBacktestMcp(
      below,
      LEVELS,
      RANGE,
      INVEST,
      false,
      true,
      0,
    );
    expect(cliBelow.trailingUpShifts).toBe(0);
    expect(mcpBelow.trailingUpShifts).toBe(cliBelow.trailingUpShifts);

    const reached = [flat(100_000), at(trigger), flat(103_000), flat(110_000)];
    const cliAt = runBacktest(reached, LEVELS, RANGE, INVEST, false, true, 0);
    const mcpAt = runBacktestMcp(
      reached,
      LEVELS,
      RANGE,
      INVEST,
      false,
      true,
      0,
    );
    expect(cliAt.trailingUpShifts).toBe(1);
    expect(mcpAt.trailingUpShifts).toBe(cliAt.trailingUpShifts);
    expect(cliAt.totalBuys).toBe(mcpAt.totalBuys);
    expect(cliAt.totalSells).toBe(mcpAt.totalSells);
    expect(cliAt.realizedPnl.eq(mcpAt.realizedPnl)).toBe(true);
    expect(cliAt.finalBase.eq(mcpAt.finalBase)).toBe(true);
    expect(cliAt.finalQuote.eq(mcpAt.finalQuote)).toBe(true);
    expect(cliAt.tradeLog).toEqual(mcpAt.tradeLog);
  });

  it("identical results across a trailing-up rebuild", () => {
    const tuCandles = [
      flat(100_000),
      flat(98_500),
      flat(101_000),
      flat(103_000),
      flat(105_000),
      flat(120_000),
      flat(108_000),
    ];
    const cli = runBacktest(tuCandles, LEVELS, RANGE, INVEST, true, true, 0);
    const mcp = runBacktestMcp(tuCandles, LEVELS, RANGE, INVEST, true, true, 0);

    expect(cli.trailingUpShifts).toBe(1);
    expect(mcp.trailingUpShifts).toBe(cli.trailingUpShifts);
    expect(cli.totalBuys).toBe(mcp.totalBuys);
    expect(cli.totalSells).toBe(mcp.totalSells);
    expect(cli.totalTrades).toBe(mcp.totalTrades);
    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.finalBase.eq(mcp.finalBase)).toBe(true);
    expect(cli.finalQuote.eq(mcp.finalQuote)).toBe(true);
    expect(cli.stopLossTriggered).toBe(mcp.stopLossTriggered);
    expect(cli.tradeLog).toEqual(mcp.tradeLog);
  });

  it("both wait with trailing up while the grid holds coins, then rebuild", () => {
    // given
    const reachesTriggerThenBuys = {
      open: d(110_000),
      high: d(110_000),
      low: d(98_000),
      close: d(98_500),
    };
    const sellsThenReachesTrigger = {
      open: d(98_500),
      high: d(110_000),
      low: d(98_500),
      close: d(110_000),
    };
    const held = [flat(100_000), reachesTriggerThenBuys];
    const sold = [...held, sellsThenReachesTrigger];

    // when
    const results = [runBacktest, runBacktestMcp].flatMap((run) => [
      run(held, LEVELS, RANGE, INVEST, false, true, 0),
      run(sold, LEVELS, RANGE, INVEST, false, true, 0),
    ]);

    // then
    expect(results.map((result) => result.trailingUpShifts)).toEqual([
      0, 1, 0, 1,
    ]);
    expect(results[0].finalBase.gt(0)).toBe(true);
  });

  it("keeps CLI and MCP large-jump rebuilds bounded and identical", () => {
    // given
    const quoteStep = new Decimal("0.00000001");
    const baseStep = new Decimal("0.00000001");
    const candles = [
      flat(100_000),
      {
        open: new Decimal("100000"),
        high: new Decimal("1000000"),
        low: new Decimal("100000"),
        close: new Decimal("1000000"),
      },
    ];

    // when
    const pow = vi.spyOn(Decimal.prototype, "pow");
    const cli = runBacktest(
      candles,
      200,
      new Decimal("0.001"),
      new Decimal("1000"),
      false,
      true,
      0,
      undefined,
      baseStep,
      quoteStep,
    );
    const cliPowCalls = pow.mock.calls.length;
    pow.mockClear();
    const mcp = runBacktestMcp(
      candles,
      200,
      new Decimal("0.001"),
      new Decimal("1000"),
      false,
      true,
      0,
      undefined,
      baseStep,
      quoteStep,
    );
    const mcpPowCalls = pow.mock.calls.length;
    pow.mockRestore();

    // then
    expect(cliPowCalls).toBeLessThan(1_000);
    expect(mcpPowCalls).toBeLessThan(1_000);
    expect(cli.trailingUpShifts).toBe(1);
    expect(mcp.trailingUpShifts).toBe(cli.trailingUpShifts);
    expect(cli.totalBuys).toBe(mcp.totalBuys);
    expect(cli.totalSells).toBe(mcp.totalSells);
    expect(cli.totalTrades).toBe(mcp.totalTrades);
    expect(cli.realizedPnl.eq(mcp.realizedPnl)).toBe(true);
    expect(cli.finalBase.eq(mcp.finalBase)).toBe(true);
    expect(cli.finalQuote.eq(mcp.finalQuote)).toBe(true);
    expect(cli.tradeLog).toEqual(mcp.tradeLog);
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
    const results = optimizeGridParams(candles, [LEVELS], [RANGE], INVEST, {
      days: 1,
      intervalDays: 1 / 24,
    });
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

describe("B — CLI ↔ MCP with real pair steps and limits", () => {
  const candles = [
    flat(100_000),
    flat(98_500),
    flat(101_000),
    flat(103_000),
    flat(100_000),
    flat(97_000),
    flat(102_000),
  ];

  for (const [baseStep, quoteStep] of [
    ["0.00001", "0.05"],
    ["0.001", "1"],
    ["0.00001", "0.0001"],
  ]) {
    it(`gives identical results with a ${quoteStep} price step`, () => {
      const cli = runBacktest(
        candles,
        LEVELS,
        RANGE,
        INVEST,
        true,
        false,
        0,
        undefined,
        d(baseStep),
        d(quoteStep),
      );
      const mcp = runBacktestMcp(
        candles,
        LEVELS,
        RANGE,
        INVEST,
        true,
        false,
        0,
        undefined,
        d(baseStep),
        d(quoteStep),
      );

      expect(cli.totalTrades).toBeGreaterThan(0);
      expect(mcp.totalTrades).toBe(cli.totalTrades);
      expect(mcp.realizedPnl.toString()).toBe(cli.realizedPnl.toString());
      expect(mcp.finalBase.toString()).toBe(cli.finalBase.toString());
      expect(mcp.finalQuote.toString()).toBe(cli.finalQuote.toString());
    });
  }

  it("both log a stop-loss sale on a low-priced pair at its full price", () => {
    const lowCandles = [flat(0.0015), flat(0.00143), flat(0.0013)];
    const run = (engine: typeof runBacktest) =>
      engine(
        lowCandles,
        LEVELS,
        RANGE,
        INVEST,
        false,
        false,
        0.0014,
        undefined,
        d("0.01"),
        d("0.0000001"),
      ).tradeLog.find((entry) => entry.includes("STOP-LOSS SELL"));

    const cli = run(runBacktest);
    const mcp = run(runBacktestMcp as typeof runBacktest);

    expect(cli).toContain("STOP-LOSS SELL @ 0.0014 |");
    expect(mcp).toBe(cli);
  });

  it("both log a trailing-up rebuild on a low-priced pair at its full price", () => {
    const rising = [flat(0.0015), flat(0.0016), flat(0.0018)];
    const run = (engine: typeof runBacktest) =>
      engine(
        rising,
        LEVELS,
        RANGE,
        INVEST,
        false,
        true,
        0,
        undefined,
        d("0.01"),
        d("0.0000001"),
      ).tradeLog.find((entry) => entry.includes("TRAILING UP"));

    const cli = run(runBacktest);
    const mcp = run(runBacktestMcp as typeof runBacktest);

    expect(cli).toMatch(/TRAILING UP: Grid rebuilt around 0\.001\d+ \(shift/);
    expect(mcp).toBe(cli);
  });

  it("logs a bot-backtest trailing-up rebuild on a low-priced pair at its full price", async () => {
    const rising = [
      flat(0.0015),
      flat(0.0018),
      flat(0.0018),
      flat(0.0018),
      flat(0.0018),
    ];

    const bot = await runBacktestBot(
      rising,
      LEVELS,
      RANGE,
      INVEST,
      false,
      true,
      0,
      undefined,
      d("0.01"),
      d("0.0000001"),
    );

    expect(
      bot.tradeLog.find((entry) => entry.includes("TRAILING UP")),
    ).toContain("Grid rebuilt around 0.0018 (shift");
  });

  it("both charge a simulated buy what its coins cost on a coarse size step", () => {
    const cycling = [flat(2000), flat(1950), flat(1900), flat(2050)];
    const run = (engine: typeof runBacktest) =>
      engine(
        cycling,
        LEVELS,
        RANGE,
        INVEST,
        false,
        false,
        0,
        undefined,
        d("0.01"),
        d("0.01"),
      );

    const cli = run(runBacktest);
    const mcp = run(runBacktestMcp as typeof runBacktest);

    const buys = cli.trades.filter((trade) => trade.side === "buy");
    expect(buys.length).toBeGreaterThan(1);
    for (const buy of buys) {
      expect(buy.quoteValue.toString()).toBe(
        buy.quantity
          .times(buy.price)
          .div("0.01")
          .ceil()
          .times("0.01")
          .toString(),
      );
    }
    const spent = cli.trades
      .filter((trade) => trade.side === "buy")
      .reduce((sum, trade) => sum.plus(trade.quoteValue), d(0));
    const received = cli.trades
      .filter((trade) => trade.side === "sell")
      .reduce((sum, trade) => sum.plus(trade.quoteValue), d(0));
    expect(cli.finalQuote.toString()).toBe(
      INVEST.minus(spent).plus(received).toString(),
    );
    expect(mcp.finalQuote.toString()).toBe(cli.finalQuote.toString());
    expect(mcp.realizedPnl.toString()).toBe(cli.realizedPnl.toString());
  });

  it("all three charge the split buy its full amount, as the exchange does for a market buy", async () => {
    const quiet = [flat(2000), flat(2000)];
    const run = (engine: typeof runBacktest) =>
      engine(
        quiet,
        LEVELS,
        RANGE,
        INVEST,
        true,
        false,
        0,
        undefined,
        d("0.01"),
        d("0.01"),
      );
    let botCash = d(0);

    const cli = run(runBacktest);
    const mcp = run(runBacktestMcp as typeof runBacktest);
    await runBacktestBot(
      quiet,
      LEVELS,
      RANGE,
      INVEST,
      true,
      false,
      0,
      (event) => {
        botCash = event.cash;
      },
      d("0.01"),
      d("0.01"),
    );

    const quotePerLevel = INVEST.div(LEVELS).div("0.01").floor().times("0.01");
    expect(cli.finalQuote.toString()).toBe(
      INVEST.minus(quotePerLevel.times(3)).toString(),
    );
    expect(mcp.finalQuote.toString()).toBe(cli.finalQuote.toString());
    expect(botCash.toString()).toBe(cli.finalQuote.toString());
  });

  it("charges a bot-backtest buy what its coins cost on a coarse size step", async () => {
    const buys: Array<{
      quantity: Decimal;
      price: Decimal;
      quoteValue: Decimal;
    }> = [];
    let lastCash = d(0);

    await runBacktestBot(
      [flat(2000), flat(1960), flat(1960)],
      LEVELS,
      RANGE,
      INVEST,
      false,
      false,
      0,
      (event) => {
        buys.push(...event.fills.filter((fill) => fill.side === "buy"));
        lastCash = event.cash;
      },
      d("0.01"),
      d("0.01"),
    );

    expect(buys.length).toBeGreaterThan(0);
    for (const buy of buys) {
      expect(buy.quoteValue.toString()).toBe(
        buy.quantity
          .times(buy.price)
          .div("0.01")
          .ceil()
          .times("0.01")
          .toString(),
      );
    }
    expect(lastCash.toString()).toBe(
      INVEST.minus(
        buys.reduce((sum, buy) => sum.plus(buy.quoteValue), d(0)),
      ).toString(),
    );
  });

  it("both refuse a grid whose orders fall below the pair's minimum", () => {
    const constraints = {
      baseStep: d("0.00001"),
      quoteStep: d("0.01"),
      minBase: d("0.00001"),
      maxBase: d("10"),
      minQuote: d("500"),
    };
    const run = (engine: typeof runBacktest) => () =>
      engine(
        candles,
        LEVELS,
        RANGE,
        INVEST,
        true,
        false,
        0,
        undefined,
        d("0.00001"),
        d("0.01"),
        constraints,
      );

    expect(run(runBacktest)).toThrow(/below the minimum/);
    expect(run(runBacktestMcp as typeof runBacktest)).toThrow(
      /below the minimum/,
    );
  });

  it("both stop an optimize sweep when the stop-loss sits inside one of its grids", () => {
    const sweep = (engine: typeof optimizeGridParams) => () =>
      engine(
        candles,
        [6],
        [d("0.03"), d("0.2")],
        INVEST,
        3,
        false,
        false,
        90_000,
      );

    expect(sweep(optimizeGridParams)).toThrow(/[Ss]top-loss/);
    expect(sweep(optimizeGridParamsMcp as typeof optimizeGridParams)).toThrow(
      /[Ss]top-loss/,
    );
  });
});

describe("annualized return", () => {
  it.each([
    [7, 1, null],
    [357, 7, null],
    [364, 1, "48.16"],
    [364, 7, "48.16"],
    [365, 1, "48.00"],
    [730, 1, "21.66"],
  ])(
    "over %s days of candles of %s days each is %s for a 48%% return",
    (days, intervalDays, expected) => {
      // when
      const coverage = { days, intervalDays };
      const cli = annualizedReturnPct(new Decimal(48), coverage);
      const mcp = annualizedReturnPctMcp(new Decimal(48), coverage);

      // then
      expect(cli?.toFixed(2) ?? null).toBe(expected);
      expect(mcp?.toFixed(2) ?? null).toBe(expected);
    },
  );

  it("never reports a loss beyond everything invested", () => {
    const coverage = { days: 400, intervalDays: 1 };
    expect(annualizedReturnPct(new Decimal(-150), coverage)?.toString()).toBe(
      "-100",
    );
    expect(
      annualizedReturnPctMcp(new Decimal(-150), coverage)?.toString(),
    ).toBe("-100");
  });

  it("measures the days the candles cover, last candle included", () => {
    // given
    const day = 24 * 60 * 60 * 1000;
    const candles = [0, 1, 2].map((index) => ({ start: index * day }));

    // then
    expect(candleCoverage(candles, day)).toEqual({ days: 3, intervalDays: 1 });
    expect(candleCoverageMcp(candles, day)).toEqual({
      days: 3,
      intervalDays: 1,
    });
    expect(candleCoverage([], day)).toEqual({ days: 0, intervalDays: 1 });
  });
});

describe("quote per level", () => {
  const constraints = {
    baseStep: new Decimal("0.001"),
    quoteStep: new Decimal("0.1"),
    minBase: new Decimal("0.001"),
    maxBase: new Decimal("100"),
    minQuote: new Decimal("1"),
  };

  it("splits the investment over the levels that hold money, rounded down to the quote step", () => {
    for (const quotePerLevel of [quotePerLevelFor, quotePerLevelForMcp]) {
      expect(
        quotePerLevel({
          investment: new Decimal(10),
          buyLevels: 3,
          sellLevels: 3,
          split: false,
          constraints,
        }).toString(),
      ).toBe("3.3");
      expect(
        quotePerLevel({
          investment: new Decimal(10),
          buyLevels: 3,
          sellLevels: 3,
          split: true,
          constraints,
        }).toString(),
      ).toBe("1.6");
    }
  });

  it("refuses an amount below the pair minimum", () => {
    for (const quotePerLevel of [quotePerLevelFor, quotePerLevelForMcp]) {
      expect(() =>
        quotePerLevel({
          investment: new Decimal(2),
          buyLevels: 3,
          sellLevels: 3,
          split: false,
          constraints,
        }),
      ).toThrow("Quote per level 0.6 is below the minimum quote order size 1.");
    }
  });
});
