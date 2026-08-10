import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  optimizeGridParams,
  runBacktest,
  runBacktestBot,
  type BacktestCandle,
} from "../../src/shared/backtest/engine.js";
import type { GridOrderConstraints } from "../../src/engine/grid-plan.js";

const CANDLES: BacktestCandle[] = [
  {
    start: 1,
    open: new Decimal("100"),
    high: new Decimal("101"),
    low: new Decimal("99"),
    close: new Decimal("100"),
  },
];

const CONSTRAINTS: GridOrderConstraints = {
  baseStep: new Decimal("0.0001"),
  quoteStep: new Decimal("0.01"),
  minBase: new Decimal("0.0001"),
  maxBase: new Decimal("10"),
  minQuote: new Decimal("5"),
};

describe("backtest grid validation", () => {
  it("rejects empty optimization parameter lists", () => {
    // then
    expect(() =>
      optimizeGridParams(
        CANDLES,
        [],
        [new Decimal("0.1")],
        new Decimal("1000"),
      ),
    ).toThrow(/at least one grid level option/i);
    expect(() =>
      optimizeGridParams(CANDLES, [10], [], new Decimal("1000")),
    ).toThrow(/at least one grid range option/i);
  });

  it("rejects an undersized backtest before simulation", () => {
    // then
    expect(() =>
      runBacktest(
        CANDLES,
        200,
        new Decimal("0.1"),
        new Decimal("100"),
        true,
        false,
        0,
        undefined,
        CONSTRAINTS.baseStep,
        CONSTRAINTS.quoteStep,
        CONSTRAINTS,
      ),
    ).toThrow(/minimum quote order size/i);
  });

  it("rejects all optimization when one combination is invalid", () => {
    // then
    expect(() =>
      optimizeGridParams(
        CANDLES,
        [4, 200],
        [new Decimal("0.1")],
        new Decimal("100"),
        1,
        true,
        false,
        0,
        CONSTRAINTS.baseStep,
        CONSTRAINTS.quoteStep,
        CONSTRAINTS,
      ),
    ).toThrow(/minimum quote order size/i);
  });

  it("rejects optimization when stop loss is inside one candidate grid", () => {
    // then
    expect(() =>
      optimizeGridParams(
        CANDLES,
        [4],
        [new Decimal("0.05"), new Decimal("0.2")],
        new Decimal("1000"),
        1,
        false,
        false,
        85,
        CONSTRAINTS.baseStep,
        CONSTRAINTS.quoteStep,
        CONSTRAINTS,
      ),
    ).toThrow(/stop-loss/i);
  });

  it("rejects a backtest workload that can exceed the CLI time budget", () => {
    // given
    const candles = Array<BacktestCandle>(150_001).fill(CANDLES[0]);

    // then
    expect(() =>
      runBacktest(candles, 200, new Decimal("0.1"), new Decimal("1000")),
    ).toThrow(/workload is too large/i);
  });

  it("rejects an oversized bot backtest workload before simulation", async () => {
    // given
    const candles = Array<BacktestCandle>(150_001).fill(CANDLES[0]);

    // then
    await expect(
      runBacktestBot(candles, 200, new Decimal("0.1"), new Decimal("1000")),
    ).rejects.toThrow(/workload is too large/i);
  });

  it("runs a 100-level-per-side bot backtest without live request pacing", async () => {
    // given
    const candles: BacktestCandle[] = [
      {
        start: 1,
        open: new Decimal("100"),
        high: new Decimal("100"),
        low: new Decimal("90"),
        close: new Decimal("90"),
      },
    ];

    // when
    const result = await runBacktestBot(
      candles,
      200,
      new Decimal("0.1"),
      new Decimal("1000"),
      false,
      false,
      0,
      undefined,
      CONSTRAINTS.baseStep,
      CONSTRAINTS.quoteStep,
      CONSTRAINTS,
    );

    // then
    expect(result.totalBuys).toBe(100);
  });

  it("rejects trailing grids that become invalid after shifting upward", async () => {
    // given
    const constraints = {
      ...CONSTRAINTS,
      baseStep: new Decimal("0.001"),
      minBase: new Decimal("0.1"),
    };
    const candles: BacktestCandle[] = [
      {
        start: 1,
        open: new Decimal("100"),
        high: new Decimal("200"),
        low: new Decimal("100"),
        close: new Decimal("200"),
      },
    ];
    const runSync = () =>
      runBacktest(
        candles,
        4,
        new Decimal("0.1"),
        new Decimal("20"),
        false,
        true,
        0,
        undefined,
        constraints.baseStep,
        constraints.quoteStep,
        constraints,
      );

    // then
    expect(runSync).toThrow(/minimum base order size/i);
    await expect(
      runBacktestBot(
        candles,
        4,
        new Decimal("0.1"),
        new Decimal("20"),
        false,
        true,
        0,
        undefined,
        constraints.baseStep,
        constraints.quoteStep,
        constraints,
      ),
    ).rejects.toThrow(/minimum base order size/i);
  });

  it("rejects aggregate optimization work before running combinations", () => {
    // given
    const candles = Array<BacktestCandle>(75_001).fill(CANDLES[0]);

    // then
    expect(() =>
      optimizeGridParams(
        candles,
        [200],
        [new Decimal("0.05"), new Decimal("0.1")],
        new Decimal("1000"),
      ),
    ).toThrow(/workload is too large/i);
  });
});
