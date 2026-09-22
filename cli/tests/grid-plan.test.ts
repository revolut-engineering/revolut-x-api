import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import {
  allocateBaseOrderSizes,
  createGridPlan,
  createGridPrices,
  constraintsFromPair,
  createTrailingGridRebuildPlan,
  normalizeBaseOrderSize,
  parseLevelsPerSide,
  type GridOrderConstraints,
} from "../src/engine/grid-plan.js";

const CONSTRAINTS: GridOrderConstraints = {
  baseStep: new Decimal("0.0001"),
  quoteStep: new Decimal("0.05"),
  minBase: new Decimal("0.0002"),
  maxBase: new Decimal("10"),
  minQuote: new Decimal("5"),
};

describe("grid plan", () => {
  it("maps every exchange order constraint", () => {
    // when
    const constraints = constraintsFromPair({
      base: "BTC",
      quote: "USD",
      base_step: "0.00001",
      quote_step: "0.05",
      min_order_size: "0.0001",
      max_order_size: "2",
      min_order_size_quote: "10",
      slippage: 0,
      status: "active",
    });

    // then
    expect(constraints.baseStep.toString()).toBe("0.00001");
    expect(constraints.quoteStep.toString()).toBe("0.05");
    expect(constraints.minBase.toString()).toBe("0.0001");
    expect(constraints.maxBase.toString()).toBe("2");
    expect(constraints.minQuote.toString()).toBe("10");
  });

  it("creates 200 valid prices for a 100-level-per-side grid", () => {
    // when
    const plan = createGridPlan({
      startPrice: new Decimal("100"),
      totalLevels: 200,
      rangePct: new Decimal("0.1"),
      investment: new Decimal("1020"),
      split: true,
      constraints: CONSTRAINTS,
    });

    // then
    expect(plan.levels).toHaveLength(200);
    expect(plan.buyLevelIndices).toHaveLength(100);
    expect(plan.sellLevelIndices).toHaveLength(100);
    expect(plan.quotePerLevel.toString()).toBe("5.1");
    expect(
      plan.levels.every(
        (level, index) =>
          index === 0 || level.price.gt(plan.levels[index - 1].price),
      ),
    ).toBe(true);
  });

  it("aligns quote allocation to non-power-of-ten steps", () => {
    // when
    const plan = createGridPlan({
      startPrice: new Decimal("100"),
      totalLevels: 10,
      rangePct: new Decimal("0.1"),
      investment: new Decimal("123.13"),
      split: true,
      constraints: CONSTRAINTS,
    });

    // then
    expect(plan.quotePerLevel.toString()).toBe("12.3");
    expect(
      plan.levels.every((level) =>
        level.price.mod(CONSTRAINTS.quoteStep).eq(0),
      ),
    ).toBe(true);
  });

  it("rejects investment that creates undersized orders", () => {
    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 200,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("100"),
        split: true,
        constraints: CONSTRAINTS,
      }),
    ).toThrow(/minimum quote order size/i);
  });

  it("rejects prices that collapse after rounding", () => {
    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("1"),
        totalLevels: 200,
        rangePct: new Decimal("0.001"),
        investment: new Decimal("1000"),
        split: true,
        constraints: CONSTRAINTS,
      }),
    ).toThrow(/unique prices/i);
  });

  it("rejects stop loss inside the rounded grid", () => {
    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 10,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("1000"),
        split: false,
        stopLoss: new Decimal("90"),
        constraints: CONSTRAINTS,
      }),
    ).toThrow(/stop-loss/i);
  });

  it("rejects stop-loss liquidation below the minimum quote size", () => {
    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 4,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("10"),
        split: false,
        stopLoss: new Decimal("80"),
        constraints: CONSTRAINTS,
      }),
    ).toThrow(/minimum quote order size/i);
  });

  it("rejects a stop-loss liquidation above the maximum base size", () => {
    // given
    const constraints = {
      ...CONSTRAINTS,
      maxBase: new Decimal("0.2"),
    };

    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 4,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("20"),
        split: false,
        stopLoss: new Decimal("80"),
        constraints,
      }),
    ).toThrow(/stop-loss liquidation.*maximum base order size/i);
  });

  it("rejects a split market buy above the maximum base size", () => {
    // given
    const constraints = {
      ...CONSTRAINTS,
      maxBase: new Decimal("0.15"),
    };

    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 4,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("40"),
        split: true,
        constraints,
      }),
    ).toThrow(/split market buy.*maximum base order size/i);
  });

  it("includes future split-slot rebuys in maximum stop-loss exposure", () => {
    // given
    const constraints = {
      ...CONSTRAINTS,
      maxBase: new Decimal("0.416"),
    };

    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 4,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("40"),
        split: true,
        stopLoss: new Decimal("80"),
        constraints,
      }),
    ).toThrow(/stop-loss liquidation.*maximum base order size/i);
  });

  it("aligns actual filled base before placing a sell", () => {
    // then
    expect(
      normalizeBaseOrderSize(new Decimal("0.00029"), CONSTRAINTS).toString(),
    ).toBe("0.0002");
  });

  it("distributes every aligned split base step across levels", () => {
    // when
    const allocations = allocateBaseOrderSizes(new Decimal("1.039"), 3, {
      ...CONSTRAINTS,
      baseStep: new Decimal("0.01"),
      minBase: new Decimal("0.01"),
    });

    // then
    expect(allocations.map((allocation) => allocation.toString())).toEqual([
      "0.35",
      "0.34",
      "0.34",
    ]);
    expect(
      allocations.reduce(
        (total, allocation) => total.plus(allocation),
        new Decimal(0),
      ),
    ).toEqual(new Decimal("1.03"));
  });

  it("rejects actual filled base that falls below the minimum", () => {
    // then
    expect(() =>
      normalizeBaseOrderSize(new Decimal("0.00019"), CONSTRAINTS),
    ).toThrow(/minimum base order size/i);
  });

  it("rejects an aligned sell whose quote value is below the minimum", () => {
    // then
    expect(() =>
      normalizeBaseOrderSize(
        new Decimal("0.0499"),
        CONSTRAINTS,
        new Decimal("100"),
      ),
    ).toThrow(/minimum quote order size/i);
  });

  it("rejects a buy whose aligned base cannot meet the paired sell minimum", () => {
    // given
    const constraints = {
      ...CONSTRAINTS,
      baseStep: new Decimal("0.03"),
      minBase: new Decimal("0.03"),
    };

    // then
    expect(() =>
      createGridPlan({
        startPrice: new Decimal("100"),
        totalLevels: 4,
        rangePct: new Decimal("0.1"),
        investment: new Decimal("10"),
        split: false,
        constraints,
      }),
    ).toThrow(/minimum quote order size/i);
  });

  it("preserves split allocations at their existing level indices", () => {
    // given
    const levels = ["90000", "96548.94", "103228.01", "110000"].map(
      (price, index) => ({ index, price: new Decimal(price) }),
    );
    const buyCounts = [1, 2, 1, 0];

    // when
    const plan = createTrailingGridRebuildPlan({
      levels,
      currentPrice: new Decimal("126000"),
      split: true,
      buyCounts,
      quoteStep: new Decimal("0.01"),
    });

    // then
    expect(plan.levels.map((level) => level.price.toString())).toEqual([
      "102882.76",
      "110369.13",
      "118004.26",
      "125745.6",
    ]);
    expect(plan.buyCounts).toEqual(buyCounts);
    expect(plan.shiftSteps).toBe(2);
  });

  it("keeps every non-split buy below an aligned rounding boundary", () => {
    // given
    const levels = createGridPrices(
      new Decimal("100000"),
      4,
      new Decimal("0.001"),
      new Decimal("0.05"),
    );
    const currentPrice = new Decimal("100233.6");

    // when
    const plan = createTrailingGridRebuildPlan({
      levels,
      currentPrice,
      split: false,
      buyCounts: [1, 1, 0, 0],
      quoteStep: new Decimal("0.05"),
    });

    // then
    expect(plan.shiftSteps).toBe(3);
    expect(plan.buyCounts).toEqual([1, 1, 0, 0]);
    expect(
      plan.levels.every(
        (level, index) =>
          plan.buyCounts[index] === 0 || level.price.lt(currentPrice),
      ),
    ).toBe(true);
    expect(plan.levels[2].price.lt(currentPrice)).toBe(true);
  });

  it("preserves trailing allocation invariants through 100 levels per side", () => {
    // given
    const ranges = ["0.01", "0.1", "0.5"];

    // when
    for (let levelsPerSide = 1; levelsPerSide <= 100; levelsPerSide++) {
      for (const range of ranges) {
        const levels = createGridPrices(
          new Decimal("100000"),
          levelsPerSide * 2,
          new Decimal(range),
          new Decimal("0.00000001"),
        );
        const lower = levels[0].price;
        const upper = levels[levels.length - 1].price;
        const ratio = upper
          .div(lower)
          .pow(new Decimal(1).div(levels.length - 1));
        const currentPrice = upper.times(ratio.pow(2)).plus("0.00000001");
        const nonSplitPlan = createTrailingGridRebuildPlan({
          levels,
          currentPrice,
          split: false,
          buyCounts: levels.map((level) =>
            level.index < levelsPerSide ? 1 : 0,
          ),
          quoteStep: new Decimal("0.00000001"),
        });
        const splitCounts = levels.map(() => 1);
        const splitPlan = createTrailingGridRebuildPlan({
          levels,
          currentPrice,
          split: true,
          buyCounts: splitCounts,
          quoteStep: new Decimal("0.00000001"),
        });

        // then
        expect(
          nonSplitPlan.buyCounts.reduce((total, count) => total + count, 0),
        ).toBe(levelsPerSide);
        expect(
          nonSplitPlan.levels.every(
            (level, index) =>
              nonSplitPlan.buyCounts[index] === 0 ||
              level.price.lt(currentPrice),
          ),
        ).toBe(true);
        expect(splitPlan.buyCounts).toEqual(splitCounts);
        expect(
          splitPlan.levels.every((level) => level.price.lt(currentPrice)),
        ).toBe(true);
      }
    }
  });

  it("bounds large-jump shift work for 100 levels per side", () => {
    // given
    const quoteStep = new Decimal("0.00000001");
    const levels = createGridPrices(
      new Decimal("100000"),
      200,
      new Decimal("0.001"),
      quoteStep,
    );
    const currentPrice = new Decimal("1000000");
    const nonSplitCounts = levels.map((level) => (level.index < 100 ? 1 : 0));
    const splitCounts = levels.map(() => 1);
    const pow = vi.spyOn(Decimal.prototype, "pow");

    // when
    const nonSplitPlan = createTrailingGridRebuildPlan({
      levels,
      currentPrice,
      split: false,
      buyCounts: nonSplitCounts,
      quoteStep,
    });
    const nonSplitPowCalls = pow.mock.calls.length;
    pow.mockClear();
    const splitPlan = createTrailingGridRebuildPlan({
      levels,
      currentPrice,
      split: true,
      buyCounts: splitCounts,
      quoteStep,
    });
    const splitPowCalls = pow.mock.calls.length;
    pow.mockRestore();

    // then
    expect(nonSplitPowCalls).toBeLessThan(1_000);
    expect(splitPowCalls).toBeLessThan(1_000);
    expect(nonSplitPlan.buyCounts).toEqual(nonSplitCounts);
    expect(splitPlan.buyCounts).toEqual(splitCounts);
    for (const plan of [nonSplitPlan, splitPlan]) {
      expect(
        plan.levels.every(
          (level, index) =>
            level.price.mod(quoteStep).eq(0) &&
            (index === 0 || level.price.gt(plan.levels[index - 1].price)) &&
            (plan.buyCounts[index] === 0 || level.price.lt(currentPrice)),
        ),
      ).toBe(true);
    }
  });
});

describe("level parsing", () => {
  it("accepts 100 levels per side", () => {
    // then
    expect(parseLevelsPerSide("100")).toBe(100);
  });

  it.each(["0", "101", "2.5", "5x", ""])(
    "rejects invalid level value %j",
    (value) => {
      // then
      expect(() => parseLevelsPerSide(value)).toThrow(
        /between 1 and 100 \(per side\)/,
      );
    },
  );
});
