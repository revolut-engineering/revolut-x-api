import { Decimal } from "decimal.js";
import type { CurrencyPair } from "@revolut/revolut-x-api";
import { findFirstGeometricShiftAbovePrice } from "./grid-math.js";

export const MAX_LEVELS_PER_SIDE = 100;
export const MAX_TOTAL_LEVELS = MAX_LEVELS_PER_SIDE * 2;

export interface GridOrderConstraints {
  baseStep: Decimal;
  quoteStep: Decimal;
  minBase: Decimal;
  maxBase: Decimal;
  minQuote: Decimal;
}

export interface GridPlanInput {
  startPrice: Decimal;
  totalLevels: number;
  rangePct: Decimal;
  investment: Decimal;
  split: boolean;
  stopLoss?: Decimal;
  constraints: GridOrderConstraints;
  takerFeeRate?: Decimal;
}

export interface GridPlanLevel {
  index: number;
  price: Decimal;
}

export interface GridPlan {
  levels: GridPlanLevel[];
  buyLevelIndices: number[];
  sellLevelIndices: number[];
  quotePerLevel: Decimal;
  splitBaseByLevel: Decimal[];
  splitCostByLevel: Decimal[];
}

export interface TrailingGridRebuildPlanInput {
  levels: GridPlanLevel[];
  currentPrice: Decimal;
  split: boolean;
  buyCounts: number[];
  quoteStep: Decimal;
}

export interface TrailingGridRebuildPlan {
  levels: GridPlanLevel[];
  buyCounts: number[];
  shiftSteps: number;
}

export function parseLevelsPerSide(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--levels must be between 1 and 100 (per side).");
  }

  const levels = Number(value);
  if (levels < 1 || levels > MAX_LEVELS_PER_SIDE) {
    throw new Error("--levels must be between 1 and 100 (per side).");
  }
  return levels;
}

export function constraintsFromPair(pair: CurrencyPair): GridOrderConstraints {
  return {
    baseStep: new Decimal(pair.base_step),
    quoteStep: new Decimal(pair.quote_step),
    minBase: new Decimal(pair.min_order_size),
    maxBase: new Decimal(pair.max_order_size),
    minQuote: new Decimal(pair.min_order_size_quote),
  };
}

export function createGridPlan(input: GridPlanInput): GridPlan {
  validateInput(input);

  const { startPrice, totalLevels, rangePct, investment, split, constraints } =
    input;
  const levels = createGridPrices(
    startPrice,
    totalLevels,
    rangePct,
    constraints.quoteStep,
  );
  const levelsPerSide = totalLevels / 2;

  if (input.stopLoss && input.stopLoss.gte(levels[0].price)) {
    throw new Error(
      `Stop-loss ${input.stopLoss} must be strictly below the lowest grid level ${levels[0].price}.`,
    );
  }

  const buyLevelIndices = levels
    .slice(0, levelsPerSide)
    .map((level) => level.index);
  const sellLevelIndices = levels
    .slice(levelsPerSide)
    .map((level) => level.index);
  const capitalLevelCount =
    buyLevelIndices.length + (split ? sellLevelIndices.length : 0);
  if (capitalLevelCount === 0) {
    throw new Error("Grid does not contain any capital-bearing levels.");
  }

  const quotePerLevel = floorToStep(
    investment.div(capitalLevelCount),
    constraints.quoteStep,
  );
  if (quotePerLevel.lt(constraints.minQuote)) {
    throw new Error(
      `Quote per level ${quotePerLevel} is below the minimum quote order size ${constraints.minQuote}.`,
    );
  }

  const buyBaseAmounts = buyLevelIndices.map((buyLevelIndex) =>
    normalizeBaseOrderSize(
      quotePerLevel.div(levels[buyLevelIndex].price),
      constraints,
      input.stopLoss ?? levels[buyLevelIndex + 1].price,
    ),
  );
  const splitCycleBaseAmounts = split
    ? sellLevelIndices.map((sellLevelIndex) => {
        const buyLevelIndex = sellLevelIndex - 1;
        return normalizeBaseOrderSize(
          quotePerLevel.div(levels[buyLevelIndex].price),
          constraints,
          input.stopLoss ?? levels[sellLevelIndex].price,
        );
      })
    : [];
  let maximumPositionBase = buyBaseAmounts.reduce(
    (sum, baseAmount) => sum.plus(baseAmount),
    new Decimal(0),
  );

  let splitBaseByLevel: Decimal[] = [];
  let splitCostByLevel: Decimal[] = [];
  if (split && sellLevelIndices.length > 0) {
    const takerFeeRate = input.takerFeeRate ?? new Decimal(0);
    const splitQuote = quotePerLevel.times(sellLevelIndices.length);
    const splitBase = floorToStep(
      splitQuote.div(startPrice).times(new Decimal(1).minus(takerFeeRate)),
      constraints.baseStep,
    );
    if (splitBase.gt(constraints.maxBase)) {
      throw new Error(
        `Split market buy base ${splitBase} exceeds the maximum base order size ${constraints.maxBase}.`,
      );
    }
    splitBaseByLevel = allocateBaseOrderSizes(
      splitBase,
      sellLevelIndices.length,
      constraints,
      sellLevelIndices.map((index) =>
        input.stopLoss ? input.stopLoss : levels[index].price,
      ),
    );
    const allocatedSplitBase = splitBaseByLevel.reduce(
      (sum, baseAmount) => sum.plus(baseAmount),
      new Decimal(0),
    );
    splitCostByLevel = splitBaseByLevel.map((baseAmount) =>
      allocatedSplitBase.gt(0)
        ? splitQuote.times(baseAmount).div(allocatedSplitBase)
        : quotePerLevel,
    );
    maximumPositionBase = maximumPositionBase.plus(
      splitBaseByLevel.reduce(
        (sum, baseAmount, index) =>
          sum.plus(Decimal.max(baseAmount, splitCycleBaseAmounts[index])),
        new Decimal(0),
      ),
    );
  }

  if (input.stopLoss && maximumPositionBase.gt(constraints.maxBase)) {
    throw new Error(
      `Maximum stop-loss liquidation ${maximumPositionBase} exceeds the maximum base order size ${constraints.maxBase}.`,
    );
  }

  return {
    levels,
    buyLevelIndices,
    sellLevelIndices,
    quotePerLevel,
    splitBaseByLevel,
    splitCostByLevel,
  };
}

export function allocateBaseOrderSizes(
  totalBase: Decimal,
  count: number,
  constraints: GridOrderConstraints,
  executionPrices: Decimal[] = [],
): Decimal[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Base order allocation count must be a positive integer.");
  }
  if (executionPrices.length > 0 && executionPrices.length !== count) {
    throw new Error("Base order allocation prices must match the order count.");
  }

  const alignedTotal = floorToStep(totalBase, constraints.baseStep);
  const basePerLevel = floorToStep(
    alignedTotal.div(count),
    constraints.baseStep,
  );
  const allocations = Array.from({ length: count }, () => basePerLevel);
  const remainderSteps = alignedTotal
    .minus(basePerLevel.times(count))
    .div(constraints.baseStep)
    .toNumber();

  for (let index = 0; index < remainderSteps; index++) {
    allocations[index] = allocations[index].plus(constraints.baseStep);
  }

  return allocations.map((allocation, index) =>
    normalizeBaseOrderSize(allocation, constraints, executionPrices[index]),
  );
}

export function createGridPrices(
  startPrice: Decimal,
  totalLevels: number,
  rangePct: Decimal,
  quoteStep: Decimal,
): GridPlanLevel[] {
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const levelsPerSide = totalLevels / 2;
  const sideIntervals = new Decimal(levelsPerSide).minus("0.5");
  const lowerRatio = startPrice
    .div(lower)
    .pow(new Decimal(1).div(sideIntervals));
  const upperRatio = upper
    .div(startPrice)
    .pow(new Decimal(1).div(sideIntervals));
  const levels: GridPlanLevel[] = [];

  for (let index = 0; index < totalLevels; index++) {
    const rawPrice =
      index < levelsPerSide
        ? lower.times(lowerRatio.pow(index))
        : startPrice.times(
            upperRatio.pow(new Decimal(index - levelsPerSide).plus("0.5")),
          );
    const price = roundToStep(rawPrice, quoteStep);
    const previous = levels[index - 1];
    if (!price.gt(0) || (previous && !price.gt(previous.price))) {
      throw new Error(
        "Grid range and level count do not produce unique prices at the pair precision.",
      );
    }
    levels.push({ index, price });
  }

  if (
    !levels[levelsPerSide - 1].price.lt(startPrice) ||
    !levels[levelsPerSide].price.gt(startPrice)
  ) {
    throw new Error(
      "Grid range and level count do not produce unique prices on both sides of the start price.",
    );
  }
  return levels;
}

export function createTrailingGridRebuildPlan(
  input: TrailingGridRebuildPlanInput,
): TrailingGridRebuildPlan {
  validateTrailingGridRebuildInput(input);

  const levelCount = input.levels.length;
  const lower = input.levels[0].price;
  const upper = input.levels[levelCount - 1].price;
  const ratio = upper.div(lower).pow(new Decimal(1).div(levelCount - 1));
  let shiftSteps: number;

  if (input.split) {
    shiftSteps = findFirstGeometricShiftAbovePrice(
      upper,
      ratio,
      input.currentPrice,
      1,
    );

    let highestAllocatedLevelIndex = -1;
    for (let index = 0; index < input.buyCounts.length; index++) {
      if (input.buyCounts[index] > 0) {
        highestAllocatedLevelIndex = index;
      }
    }
    let adjustmentCount = 0;
    while (
      highestAllocatedLevelIndex >= 0 &&
      shiftSteps > 0 &&
      shiftedGridPrice(
        input.levels[highestAllocatedLevelIndex].price,
        ratio,
        shiftSteps,
        input.quoteStep,
      ).gte(input.currentPrice)
    ) {
      if (adjustmentCount >= levelCount + 1) {
        throw new Error("Trailing grid rounding adjustment did not converge.");
      }
      shiftSteps--;
      adjustmentCount++;
    }
  } else {
    const levelsPerSide = levelCount / 2;
    const sellBoundary = input.levels[levelsPerSide].price;
    shiftSteps = findFirstGeometricShiftAbovePrice(
      sellBoundary,
      ratio,
      input.currentPrice,
      levelsPerSide + 1,
    );
    let adjustmentCount = 0;
    while (
      shiftSteps > 0 &&
      shiftedGridPrice(
        input.levels[levelsPerSide - 1].price,
        ratio,
        shiftSteps,
        input.quoteStep,
      ).gte(input.currentPrice)
    ) {
      if (adjustmentCount >= levelCount + 1) {
        throw new Error("Trailing grid rounding adjustment did not converge.");
      }
      shiftSteps--;
      adjustmentCount++;
    }
    adjustmentCount = 0;
    while (
      shiftedGridPrice(
        input.levels[levelsPerSide - 1].price,
        ratio,
        shiftSteps + 1,
        input.quoteStep,
      ).lt(input.currentPrice)
    ) {
      if (adjustmentCount >= levelCount + 1) {
        throw new Error("Trailing grid rounding adjustment did not converge.");
      }
      shiftSteps++;
      adjustmentCount++;
    }
  }

  const shiftRatio = ratio.pow(shiftSteps);
  const levels = input.levels.map((level) => ({
    index: level.index,
    price: roundToStep(level.price.times(shiftRatio), input.quoteStep),
  }));
  const buyCounts = input.split
    ? [...input.buyCounts]
    : levels.map((_, index) => (index < levelCount / 2 ? 1 : 0));

  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    const previous = levels[index - 1];
    if (!level.price.gt(0) || (previous && !level.price.gt(previous.price))) {
      throw new Error(
        "Trailing grid does not produce unique prices at the pair precision.",
      );
    }
    if (buyCounts[index] > 0 && !level.price.lt(input.currentPrice)) {
      throw new Error(
        "Trailing grid cannot place every planned buy below the current price.",
      );
    }
  }

  return { levels, buyCounts, shiftSteps };
}

export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.gt(0)) {
    throw new Error(`Order step must be greater than zero, received ${step}.`);
  }
  return value.div(step).floor().times(step);
}

export function roundToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.gt(0)) {
    throw new Error(`Order step must be greater than zero, received ${step}.`);
  }
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step);
}

export function normalizeBaseOrderSize(
  baseAmount: Decimal,
  constraints: GridOrderConstraints,
  price?: Decimal,
): Decimal {
  const alignedBaseAmount = floorToStep(baseAmount, constraints.baseStep);
  validateBaseAmount(alignedBaseAmount, constraints);
  if (price && alignedBaseAmount.times(price).lt(constraints.minQuote)) {
    throw new Error(
      `Order quote value ${alignedBaseAmount.times(price)} is below the minimum quote order size ${constraints.minQuote}.`,
    );
  }
  return alignedBaseAmount;
}

function validateInput(input: GridPlanInput): void {
  if (
    !Number.isInteger(input.totalLevels) ||
    input.totalLevels < 2 ||
    input.totalLevels > MAX_TOTAL_LEVELS ||
    input.totalLevels % 2 !== 0
  ) {
    throw new Error(
      "Total grid levels must be an even number between 2 and 200.",
    );
  }
  if (!input.startPrice.gt(0)) {
    throw new Error("Grid start price must be greater than zero.");
  }
  if (!input.rangePct.gt(0) || input.rangePct.gte(1)) {
    throw new Error("Grid range must be greater than 0% and less than 100%.");
  }
  if (!input.investment.gt(0)) {
    throw new Error("Grid investment must be greater than zero.");
  }
  if (input.stopLoss && !input.stopLoss.gt(0)) {
    throw new Error("Stop-loss price must be greater than zero.");
  }
  if (!input.constraints.baseStep.gt(0)) {
    throw new Error("Base step must be greater than zero.");
  }
  if (!input.constraints.quoteStep.gt(0)) {
    throw new Error("Quote step must be greater than zero.");
  }
  if (input.constraints.minBase.lt(0)) {
    throw new Error("Minimum base order size cannot be negative.");
  }
  if (input.constraints.maxBase.lt(input.constraints.minBase)) {
    throw new Error("Maximum base order size cannot be below the minimum.");
  }
  if (input.constraints.minQuote.lt(0)) {
    throw new Error("Minimum quote order size cannot be negative.");
  }
}

function validateTrailingGridRebuildInput(
  input: TrailingGridRebuildPlanInput,
): void {
  if (
    input.levels.length < 2 ||
    input.levels.length > MAX_TOTAL_LEVELS ||
    input.levels.length % 2 !== 0
  ) {
    throw new Error(
      "Trailing grid must contain an even number of levels between 2 and 200.",
    );
  }
  if (input.buyCounts.length !== input.levels.length) {
    throw new Error("Trailing grid buy counts must match the level count.");
  }
  if (!input.currentPrice.isFinite() || !input.currentPrice.gt(0)) {
    throw new Error("Trailing grid current price must be greater than zero.");
  }
  if (!input.quoteStep.isFinite() || !input.quoteStep.gt(0)) {
    throw new Error("Trailing grid quote step must be greater than zero.");
  }

  for (let index = 0; index < input.levels.length; index++) {
    const level = input.levels[index];
    const previous = input.levels[index - 1];
    if (
      !level.price.isFinite() ||
      !level.price.gt(0) ||
      (previous && !level.price.gt(previous.price))
    ) {
      throw new Error(
        "Trailing grid source prices must be strictly increasing.",
      );
    }
    if (
      !Number.isSafeInteger(input.buyCounts[index]) ||
      input.buyCounts[index] < 0
    ) {
      throw new Error(
        "Trailing grid buy counts must be non-negative safe integers.",
      );
    }
  }
}

function shiftedGridPrice(
  price: Decimal,
  ratio: Decimal,
  shiftSteps: number,
  quoteStep: Decimal,
): Decimal {
  return roundToStep(price.times(ratio.pow(shiftSteps)), quoteStep);
}

function validateBaseAmount(
  baseAmount: Decimal,
  constraints: GridOrderConstraints,
): void {
  if (baseAmount.lt(constraints.minBase)) {
    throw new Error(
      `Base per level ${baseAmount} is below the minimum base order size ${constraints.minBase}.`,
    );
  }
  if (baseAmount.gt(constraints.maxBase)) {
    throw new Error(
      `Base per level ${baseAmount} exceeds the maximum base order size ${constraints.maxBase}.`,
    );
  }
}
