import { Decimal } from "decimal.js";
import type { CurrencyPair } from "@revolut/revolut-x-api";

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
    const splitQuote = quotePerLevel.times(sellLevelIndices.length);
    const splitBase = floorToStep(
      splitQuote.div(startPrice),
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
