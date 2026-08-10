import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { ForegroundGridBot } from "../../engine/grid-bot.js";
import type {
  GridBotConfig,
  GridExchangeRateLimiter,
} from "../../engine/grid-bot.js";
import { trailUpTriggerFromBounds } from "../../engine/grid-math.js";
import {
  createGridPlan,
  createGridPrices,
  floorToStep,
  normalizeBaseOrderSize,
  roundToStep,
  type GridOrderConstraints,
} from "../../engine/grid-plan.js";
import { SimulatedExchange } from "./simulated-exchange.js";
import type {
  GridState,
  GridLevelState,
  GridLevelPosition,
} from "../../db/grid-store.js";

export interface BacktestCandle {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  start?: number;
  volume?: Decimal;
}

interface GridLevel {
  price: Decimal;
  index: number;
  buyCount: number; // pending buy orders at this level
  positions: BacktestPosition[];
}

interface BacktestPosition {
  baseHeld: Decimal;
  costBasis: Decimal;
}

interface BacktestResult {
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  realizedPnl: Decimal;
  finalBase: Decimal;
  finalQuote: Decimal;
  maxDrawdown: Decimal;
  tradeLog: string[];
  trades: BacktestTrade[];
  trailingUpShifts: number;
  stopLossTriggered: boolean;
}

const MAX_BACKTEST_LEVEL_EVALUATIONS = 30_000_000;
const PASSTHROUGH_RATE_LIMITER: GridExchangeRateLimiter = {
  place: (operation) => operation(),
  cancel: (operation) => operation(),
  query: (operation) => operation(),
};

export type BacktestFillTrigger = "grid" | "stop-loss" | "trailing-up";

export interface BacktestTrade {
  index: number;
  side: "buy" | "sell";
  trigger: BacktestFillTrigger;
  price: Decimal;
  quantity: Decimal;
  quoteValue: Decimal;
  profit?: Decimal;
  realizedPnl: Decimal;
  roiPct: Decimal;
}

export interface BacktestFill {
  side: "buy" | "sell";
  price: Decimal;
  quantity: Decimal;
  quoteValue: Decimal;
  profit?: Decimal;
  trigger: BacktestFillTrigger;
}

export interface BacktestTickEvent {
  index: number;
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  fills: BacktestFill[];
  position: Decimal;
  cash: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalValue: Decimal;
}

export type BacktestOnTick = (event: BacktestTickEvent) => void;

interface OptimizationResult {
  gridLevels: number;
  rangePct: Decimal;
  investment: Decimal;
  realizedPnl: Decimal;
  totalReturn: Decimal;
  returnPct: Decimal;
  totalTrades: number;
  maxDrawdown: Decimal;
  profitPerTrade: Decimal;
  calmarApprox: Decimal;
}

function createEmptyResult(): BacktestResult {
  return {
    totalTrades: 0,
    totalBuys: 0,
    totalSells: 0,
    realizedPnl: new Decimal(0),
    finalBase: new Decimal(0),
    finalQuote: new Decimal(0),
    maxDrawdown: new Decimal(0),
    tradeLog: [],
    trades: [],
    trailingUpShifts: 0,
    stopLossTriggered: false,
  };
}

function unboundedConstraints(
  baseStep: Decimal,
  quoteStep: Decimal,
): GridOrderConstraints {
  return {
    baseStep,
    quoteStep,
    minBase: new Decimal(0),
    maxBase: new Decimal(Infinity),
    minQuote: new Decimal(0),
  };
}

function validateBacktestWorkload(levelEvaluations: number): void {
  if (levelEvaluations > MAX_BACKTEST_LEVEL_EVALUATIONS) {
    throw new Error(
      `Backtest workload is too large (${levelEvaluations.toLocaleString()} level evaluations). ` +
        `Reduce --levels, --ranges, --days, or use a wider candle interval.`,
    );
  }
}

export function createGrid(
  startPrice: Decimal,
  gridLevels: number,
  rangePct: Decimal,
  quoteDp = 2,
): GridLevel[] {
  const quoteStep = new Decimal(10).pow(-quoteDp);
  return createGridPrices(startPrice, gridLevels, rangePct, quoteStep).map(
    (level) => ({
      price: level.price,
      index: level.index,
      buyCount: level.index < gridLevels / 2 ? 1 : 0,
      positions: [],
    }),
  );
}

function sumBaseHeld(levels: GridLevel[]): Decimal {
  let total = new Decimal(0);
  for (const lv of levels) {
    for (const position of lv.positions) {
      total = total.plus(position.baseHeld);
    }
  }
  return total;
}

function fmtPnl(v: Decimal): string {
  const sign = v.gte(0) ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function emitTick(
  cb: BacktestOnTick,
  index: number,
  candle: BacktestCandle,
  levels: GridLevel[],
  quoteBalance: Decimal,
  result: BacktestResult,
  fills: BacktestFill[],
): void {
  let position = new Decimal(0);
  let costBasis = new Decimal(0);
  for (const lv of levels) {
    for (const openPosition of lv.positions) {
      position = position.plus(openPosition.baseHeld);
      costBasis = costBasis.plus(openPosition.costBasis);
    }
  }
  const markPrice = candle.close;
  const unrealized = position.times(markPrice).minus(costBasis);
  const totalValue = quoteBalance.plus(position.times(markPrice));
  const ts = typeof candle.start === "number" ? candle.start : Date.now();
  cb({
    index,
    timestamp: ts,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    fills,
    position,
    cash: quoteBalance,
    realizedPnl: result.realizedPnl,
    unrealizedPnl: unrealized,
    totalValue,
  });
}

function runBuyPass(
  levels: GridLevel[],
  low: Decimal,
  quotePerLevel: Decimal,
  result: BacktestResult,
  quoteBalance: Decimal,
  investment: Decimal,
  tickFills: BacktestFill[],
  baseStep: Decimal,
): Decimal {
  for (const level of levels) {
    if (level.buyCount > 0 && low.lte(level.price)) {
      const baseBought = floorToStep(quotePerLevel.div(level.price), baseStep);

      for (let i = 0; i < level.buyCount; i++) {
        level.positions.push({
          baseHeld: baseBought,
          costBasis: quotePerLevel,
        });
        quoteBalance = quoteBalance.minus(quotePerLevel);
        result.totalBuys += 1;
        result.totalTrades += 1;

        const totalPnl = quoteBalance
          .plus(sumBaseHeld(levels).times(level.price))
          .minus(investment);
        const roiPct = investment.isZero()
          ? new Decimal(0)
          : totalPnl.div(investment).times(100);

        result.tradeLog.push(
          `#${result.totalTrades}  BUY  @ ${level.price} | qty ${baseBought} | -${quotePerLevel} | ` +
            `realized=${fmtPnl(result.realizedPnl)} | total=${fmtPnl(totalPnl)} | ROI=${fmtPnl(roiPct)}%`,
        );
        result.trades.push({
          index: result.totalTrades,
          side: "buy",
          trigger: "grid",
          price: level.price,
          quantity: baseBought,
          quoteValue: quotePerLevel,
          realizedPnl: result.realizedPnl,
          roiPct,
        });
        tickFills.push({
          side: "buy",
          price: level.price,
          quantity: baseBought,
          quoteValue: quotePerLevel,
          trigger: "grid",
        });
      }
      level.buyCount = 0;
    }
  }
  return quoteBalance;
}

function runSellPass(
  levels: GridLevel[],
  high: Decimal,
  quotePerLevel: Decimal,
  result: BacktestResult,
  quoteBalance: Decimal,
  investment: Decimal,
  tickFills: BacktestFill[],
  quoteStep: Decimal,
): Decimal {
  for (const level of levels) {
    if (level.positions.length > 0 && level.index + 1 < levels.length) {
      const sellLevel = levels[level.index + 1];
      if (high.gte(sellLevel.price)) {
        const positionsToSell = level.positions.splice(0);

        for (const position of positionsToSell) {
          const baseHeld = position.baseHeld;
          const quoteReceived = floorToStep(
            baseHeld.times(sellLevel.price),
            quoteStep,
          );
          const profit = quoteReceived.minus(position.costBasis);

          level.buyCount++;
          quoteBalance = quoteBalance.plus(quoteReceived);
          result.totalSells += 1;
          result.totalTrades += 1;
          result.realizedPnl = result.realizedPnl.plus(profit);

          tickFills.push({
            side: "sell",
            price: sellLevel.price,
            quantity: baseHeld,
            quoteValue: quoteReceived,
            profit,
            trigger: "grid",
          });

          const totalPnl = quoteBalance
            .plus(sumBaseHeld(levels).times(sellLevel.price))
            .minus(investment);
          const roiPct = investment.isZero()
            ? new Decimal(0)
            : totalPnl.div(investment).times(100);

          result.tradeLog.push(
            `#${result.totalTrades}  SELL @ ${sellLevel.price} | qty ${baseHeld} | ` +
              `+${quoteReceived} | profit=${profit.toFixed(2)} | ` +
              `realized=${fmtPnl(result.realizedPnl)} | total=${fmtPnl(totalPnl)} | ROI=${fmtPnl(roiPct)}%`,
          );
          result.trades.push({
            index: result.totalTrades,
            side: "sell",
            trigger: "grid",
            price: sellLevel.price,
            quantity: baseHeld,
            quoteValue: quoteReceived,
            profit,
            realizedPnl: result.realizedPnl,
            roiPct,
          });
        }
      }
    }
  }
  return quoteBalance;
}

function simulateCandle(
  levels: GridLevel[],
  open: Decimal,
  low: Decimal,
  high: Decimal,
  close: Decimal,
  quotePerLevel: Decimal,
  result: BacktestResult,
  quoteBalance: Decimal,
  investment: Decimal,
  tickFills: BacktestFill[],
  baseStep: Decimal,
  quoteStep: Decimal,
): Decimal {
  const bearish = open.gt(close);
  if (bearish) {
    quoteBalance = runSellPass(
      levels,
      high,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
      quoteStep,
    );
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
      baseStep,
    );
  } else {
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
      baseStep,
    );
    quoteBalance = runSellPass(
      levels,
      high,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
      quoteStep,
    );
  }

  return quoteBalance;
}

export function runBacktest(
  candles: Array<BacktestCandle>,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  split = false,
  trailingUp = false,
  stopLossPrice = 0,
  onTick?: BacktestOnTick,
  baseStep = new Decimal("0.00001"),
  quoteStep = new Decimal("0.01"),
  orderConstraints?: GridOrderConstraints,
): BacktestResult {
  if (candles.length === 0) {
    return createEmptyResult();
  }
  validateBacktestWorkload(candles.length * gridLevels);

  const startPrice = candles[0].open;
  const constraints =
    orderConstraints ?? unboundedConstraints(baseStep, quoteStep);
  const plan = createGridPlan({
    startPrice,
    totalLevels: gridLevels,
    rangePct,
    investment,
    split,
    stopLoss: stopLossPrice > 0 ? new Decimal(stopLossPrice) : undefined,
    constraints,
  });
  const levels: GridLevel[] = plan.levels.map((level) => ({
    price: level.price,
    index: level.index,
    buyCount: level.index < gridLevels / 2 ? 1 : 0,
    positions: [],
  }));

  const sellLevelIndices: number[] = [];
  if (split) {
    for (const lv of levels) {
      if (lv.price.gt(startPrice)) {
        sellLevelIndices.push(lv.index);
      }
    }
  }

  const quotePerLevel = plan.quotePerLevel;

  const result = createEmptyResult();
  let quoteBalance = investment;
  let peakValue = investment;

  if (split && sellLevelIndices.length > 0) {
    for (let index = 0; index < sellLevelIndices.length; index++) {
      const sellIdx = sellLevelIndices[index];
      const buyLevel = levels[sellIdx - 1];
      if (buyLevel) {
        buyLevel.positions.push({
          baseHeld: plan.splitBaseByLevel[index],
          costBasis: plan.splitCostByLevel[index],
        });
        // NOTE: buyCount NOT cleared — split init does not consume the buy slot
      }
    }

    const splitCost = quotePerLevel.times(sellLevelIndices.length);
    quoteBalance = quoteBalance.minus(splitCost);

    result.tradeLog.push(
      `SPLIT: Market buy ${sellLevelIndices.length} positions @ ${startPrice} | -${splitCost.toFixed(2)}`,
    );
  }

  // Fix the stop-loss price before the candle loop so it never moves,
  // even when trailing-up rebuilds the grid around a new centre price.
  const fixedSlPrice = stopLossPrice > 0 ? new Decimal(stopLossPrice) : null;

  for (let tickIdx = 0; tickIdx < candles.length; tickIdx++) {
    const candle = candles[tickIdx];
    const tickFills: BacktestFill[] = [];
    // Stop-loss check: did the candle's low breach the fixed threshold?
    if (fixedSlPrice && candle.low.lte(fixedSlPrice)) {
      // Simulate market sell of all held positions at the stop-loss price
      for (const level of levels) {
        while (level.positions.length > 0) {
          const position = level.positions.pop()!;
          const baseHeld = position.baseHeld;
          const quoteReceived = floorToStep(
            baseHeld.times(fixedSlPrice),
            quoteStep,
          );
          const profit = quoteReceived.minus(position.costBasis);
          quoteBalance = quoteBalance.plus(quoteReceived);
          result.realizedPnl = result.realizedPnl.plus(profit);
          result.totalSells++;
          result.totalTrades++;
          result.tradeLog.push(
            `#${result.totalTrades}  STOP-LOSS SELL @ ${fixedSlPrice.toFixed(2)} | qty ${baseHeld.toFixed(5)} | ` +
              `+${quoteReceived.toFixed(2)} | profit=${profit.toFixed(2)}`,
          );
          {
            const totalPnl = quoteBalance
              .plus(sumBaseHeld(levels).times(fixedSlPrice))
              .minus(investment);
            result.trades.push({
              index: result.totalTrades,
              side: "sell",
              trigger: "stop-loss",
              price: fixedSlPrice,
              quantity: baseHeld,
              quoteValue: quoteReceived,
              profit,
              realizedPnl: result.realizedPnl,
              roiPct: investment.isZero()
                ? new Decimal(0)
                : totalPnl.div(investment).times(100),
            });
          }
          tickFills.push({
            side: "sell",
            price: fixedSlPrice,
            quantity: baseHeld,
            quoteValue: quoteReceived,
            profit,
            trigger: "stop-loss",
          });
        }
      }
      result.stopLossTriggered = true;
      if (onTick) {
        emitTick(
          onTick,
          tickIdx,
          candle,
          levels,
          quoteBalance,
          result,
          tickFills,
        );
      }
      break;
    }

    quoteBalance = simulateCandle(
      levels,
      candle.open,
      candle.low,
      candle.high,
      candle.close,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
      baseStep,
      quoteStep,
    );

    // Trailing up check: did the candle's high breach the upper boundary + one step?
    if (trailingUp) {
      const upper = levels[levels.length - 1].price;
      const lower = levels[0].price;
      const ratio = upper.div(lower).pow(new Decimal(1).div(levels.length - 1));
      const trigger = trailUpTriggerFromBounds(lower, upper, levels.length);
      const hasOpenPositions = levels.some(
        (level) => level.positions.length > 0,
      );
      if (trigger !== null && candle.high.gte(trigger) && !hasOpenPositions) {
        const rebuildPrice = candle.close;

        // Save buyCount before sell pass clears things (used to restore split slots)
        const savedBuyCounts = levels.map((l) => l.buyCount);

        let k: number;
        if (split) {
          k = 1;
          while (upper.times(ratio.pow(k)).lte(rebuildPrice)) k++;
        } else {
          const sellBoundary = levels[Math.floor(levels.length / 2)].price;
          k = Math.floor(levels.length / 2) + 1;
          while (sellBoundary.times(ratio.pow(k)).lte(rebuildPrice)) k++;
        }
        const ratioK = ratio.pow(k);
        const candidatePrices = levels.map((level) =>
          roundToStep(level.price.times(ratioK), quoteStep),
        );
        for (let i = 0; i < candidatePrices.length; i++) {
          const price = candidatePrices[i];
          if (!price.gt(0) || (i > 0 && !price.gt(candidatePrices[i - 1]))) {
            throw new Error(
              "Trailing grid does not produce unique prices at the pair precision.",
            );
          }
          const buyCount = split ? savedBuyCounts[i] : 1;
          if (price.lt(rebuildPrice) && buyCount > 0) {
            const executionPrice =
              stopLossPrice > 0
                ? new Decimal(stopLossPrice)
                : candidatePrices[Math.min(i + 1, candidatePrices.length - 1)];
            normalizeBaseOrderSize(
              quotePerLevel.div(price),
              constraints,
              executionPrice,
            );
          }
        }

        for (let i = 0; i < levels.length; i++) {
          levels[i].price = candidatePrices[i];
        }

        // Reset buy counts and positions based on new prices
        for (let i = 0; i < levels.length; i++) {
          const level = levels[i];
          if (level.price.lt(rebuildPrice)) {
            level.buyCount = split ? savedBuyCounts[i] : 1;
          } else {
            level.buyCount = 0;
          }
          level.positions = [];
        }
        // quotePerLevel is preserved (not recalculated), matching CLI bot behaviour

        result.trailingUpShifts++;
        result.tradeLog.push(
          `TRAILING UP: Grid rebuilt around ${rebuildPrice.toFixed(2)} (shift #${result.trailingUpShifts})`,
        );
      }
    }

    const highValue = quoteBalance.plus(sumBaseHeld(levels).times(candle.high));
    peakValue = Decimal.max(peakValue, highValue);
    const lowValue = quoteBalance.plus(sumBaseHeld(levels).times(candle.low));
    if (peakValue.gt(0)) {
      const drawdown = peakValue.minus(lowValue).div(peakValue);
      result.maxDrawdown = Decimal.max(result.maxDrawdown, drawdown);
    }

    if (onTick) {
      emitTick(
        onTick,
        tickIdx,
        candle,
        levels,
        quoteBalance,
        result,
        tickFills,
      );
    }
  }

  result.finalBase = sumBaseHeld(levels);
  result.finalQuote = quoteBalance;

  return result;
}

export function optimizeGridParams(
  candles: Array<BacktestCandle>,
  gridLevelsRange?: number[],
  rangePctRange?: Decimal[],
  investment: Decimal = new Decimal(1000),
  days: number = 30,
  split = false,
  trailingUp = false,
  stopLossPrice = 0,
  baseStep = new Decimal("0.00001"),
  quoteStep = new Decimal("0.01"),
  orderConstraints?: GridOrderConstraints,
): OptimizationResult[] {
  if (candles.length === 0) {
    return [];
  }

  if (!gridLevelsRange) {
    gridLevelsRange = [6, 10, 16, 20, 30, 40, 50, 60];
  }
  if (!rangePctRange) {
    rangePctRange = [
      new Decimal("0.03"),
      new Decimal("0.05"),
      new Decimal("0.07"),
      new Decimal("0.10"),
      new Decimal("0.12"),
      new Decimal("0.15"),
      new Decimal("0.20"),
    ];
  }
  if (gridLevelsRange.length === 0) {
    throw new Error("At least one grid level option is required.");
  }
  if (rangePctRange.length === 0) {
    throw new Error("At least one grid range option is required.");
  }

  validateBacktestWorkload(
    candles.length *
      rangePctRange.length *
      gridLevelsRange.reduce((sum, levels) => sum + levels, 0),
  );

  const finalPrice = candles[candles.length - 1].close;
  const startPrice = candles[0].open;
  const results: OptimizationResult[] = [];
  const constraints =
    orderConstraints ?? unboundedConstraints(baseStep, quoteStep);

  for (const levels of gridLevelsRange) {
    for (const rangePct of rangePctRange) {
      createGridPlan({
        startPrice,
        totalLevels: levels,
        rangePct,
        investment,
        split,
        stopLoss: stopLossPrice > 0 ? new Decimal(stopLossPrice) : undefined,
        constraints,
      });
    }
  }

  for (const levels of gridLevelsRange) {
    for (const rangePct of rangePctRange) {
      const bt = runBacktest(
        candles,
        levels,
        rangePct,
        investment,
        split,
        trailingUp,
        stopLossPrice,
        undefined,
        baseStep,
        quoteStep,
        constraints,
      );

      const totalValue = bt.finalQuote.plus(bt.finalBase.times(finalPrice));
      const totalReturn = totalValue.minus(investment);
      const returnPct = investment.isZero()
        ? new Decimal(0)
        : totalReturn.div(investment).times(100);

      const profitPerTrade =
        bt.totalSells > 0 ? bt.realizedPnl.div(bt.totalSells) : new Decimal(0);

      const annualizedReturn = returnPct.div(100).times(365).div(days);
      const calmar = bt.maxDrawdown.gt(0)
        ? annualizedReturn.div(bt.maxDrawdown)
        : annualizedReturn;

      results.push({
        gridLevels: levels,
        rangePct,
        investment,
        realizedPnl: bt.realizedPnl,
        totalReturn,
        returnPct,
        totalTrades: bt.totalTrades,
        maxDrawdown: bt.maxDrawdown,
        profitPerTrade,
        calmarApprox: calmar,
      });
    }
  }

  results.sort((a, b) => b.totalReturn.cmp(a.totalReturn));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bot-driven backtest — drives ForegroundGridBot with a SimulatedExchange.
//  Uses candle.close as the tick price (same as the live bot's price source).
//  This implementation exercises the exact same code paths as the live bot.
// ─────────────────────────────────────────────────────────────────────────────

function botTotalBaseHeld(state: GridState): Decimal {
  let total = new Decimal(0);
  for (const lv of state.levels) {
    for (const pos of lv.positions) {
      total = total.plus(pos.baseHeld);
    }
  }
  return total;
}

function botComputePosition(state: GridState): {
  position: Decimal;
  costBasis: Decimal;
} {
  let position = new Decimal(0);
  let costBasis = new Decimal(0);
  for (const lv of state.levels) {
    for (const pos of lv.positions) {
      const held = new Decimal(pos.baseHeld);
      if (held.gt(0)) {
        position = position.plus(held);
        const cost =
          pos.fillCost && pos.fillCost !== "0"
            ? new Decimal(pos.fillCost)
            : held.times(new Decimal(lv.price));
        costBasis = costBasis.plus(cost);
      }
    }
  }
  return { position, costBasis };
}

function buildBotInitialState(
  startPrice: Decimal,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  split: boolean,
  trailingUp: boolean,
  stopLossPrice: number,
  exchange: SimulatedExchange,
  baseDp = 5,
  quoteDp = 2,
  orderConstraints?: GridOrderConstraints,
): { state: GridState; quotePerLevel: Decimal } {
  const defaultBaseStep = new Decimal(10).pow(-baseDp);
  const defaultQuoteStep = new Decimal(10).pow(-quoteDp);
  const constraints =
    orderConstraints ?? unboundedConstraints(defaultBaseStep, defaultQuoteStep);
  const plan = createGridPlan({
    startPrice,
    totalLevels: gridLevels,
    rangePct,
    investment,
    split,
    stopLoss: stopLossPrice > 0 ? new Decimal(stopLossPrice) : undefined,
    constraints,
  });
  const levels: GridLevelState[] = plan.levels.map((level) => ({
    index: level.index,
    price: level.price.toString(),
    buyOrderIds: [],
    positions: [],
  }));

  const buyLevelsList = levels.filter((l) =>
    new Decimal(l.price).lt(startPrice),
  );
  const sellLevelIndices: number[] = [];
  if (split) {
    for (const l of levels) {
      if (new Decimal(l.price).gt(startPrice)) {
        sellLevelIndices.push(l.index);
      }
    }
  }

  const quotePerLevel = plan.quotePerLevel;

  const state: GridState = {
    id: randomUUID().slice(0, 8),
    pair: "BTC-USD",
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      levels: gridLevels,
      rangePct: rangePct.toString(),
      investment: investment.toString(),
      splitInvestment: split,
      intervalSec: 1,
      dryRun: false,
      trailingUp,
      stopLoss:
        stopLossPrice > 0 ? new Decimal(stopLossPrice).toString() : undefined,
    },
    splitExecuted: false,
    shiftCount: 0,
    gridPrice: startPrice.toString(),
    quotePrecision: constraints.quoteStep.toString(),
    basePrecision: constraints.baseStep.toString(),
    quotePerLevel: quotePerLevel.toString(),
    levels,
    stats: {
      totalBuys: 0,
      totalSells: 0,
      realizedPnl: "0",
      totalFees: "0",
    },
    tradeLog: [],
  };

  // Seed buy orders into exchange
  for (const level of buyLevelsList) {
    const id = `init-buy-${level.index}-${randomUUID().slice(0, 4)}`;
    exchange.seedOrder({
      id,
      side: "buy",
      type: "limit",
      price: new Decimal(level.price),
      quoteSize: quotePerLevel,
    });
    level.buyOrderIds.push(id);
  }

  // For split mode: create positions and seed sell orders
  if (split && sellLevelIndices.length > 0) {
    for (let index = 0; index < sellLevelIndices.length; index++) {
      const sellIdx = sellLevelIndices[index];
      const buyLevel = levels[sellIdx - 1];
      const sellLevel = levels[sellIdx];
      if (!buyLevel || !sellLevel) continue;

      const baseForLevel = plan.splitBaseByLevel[index];

      const sellId = `init-sell-${sellIdx}-${randomUUID().slice(0, 4)}`;
      const pos: GridLevelPosition = {
        id: `split-${sellIdx}`,
        baseHeld: baseForLevel.toString(),
        fillCost: plan.splitCostByLevel[index].toString(),
        sellOrderId: sellId,
      };
      buyLevel.positions.push(pos);

      exchange.seedOrder({
        id: sellId,
        side: "sell",
        type: "limit",
        price: new Decimal(sellLevel.price),
        baseSize: baseForLevel,
      });
    }

    state.splitExecuted = true;
  }

  return { state, quotePerLevel };
}

/**
 * Bot-driven backtest. Drives `ForegroundGridBot._tick()` with a
 * `SimulatedExchange` for each candle, using candle.close as the tick price.
 *
 * This exercises the exact same code paths as the live bot. Unlike the
 * synchronous `runBacktest`, fills are based on candle.close (not high/low).
 */
export async function runBacktestBot(
  candles: Array<BacktestCandle>,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  split = false,
  trailingUp = false,
  stopLossPrice = 0,
  onTick?: BacktestOnTick,
  baseStep = new Decimal("0.00001"),
  quoteStep = new Decimal("0.01"),
  orderConstraints?: GridOrderConstraints,
): Promise<BacktestResult> {
  const baseDp = baseStep.decimalPlaces() ?? 5;
  const quoteDp = quoteStep.decimalPlaces() ?? 2;
  if (candles.length === 0) {
    return createEmptyResult();
  }
  validateBacktestWorkload(candles.length * gridLevels);

  const result = createEmptyResult();
  const startPrice = candles[0].open;
  const constraints =
    orderConstraints ?? unboundedConstraints(baseStep, quoteStep);
  const exchange = new SimulatedExchange(
    constraints.baseStep,
    constraints.quoteStep,
  );

  const { state, quotePerLevel } = buildBotInitialState(
    startPrice,
    gridLevels,
    rangePct,
    investment,
    split,
    trailingUp,
    stopLossPrice,
    exchange,
    baseDp,
    quoteDp,
    constraints,
  );

  // Compute initial cash balance
  let initialCash = investment;
  if (split) {
    const sellLevelCount = state.levels.filter((l) =>
      new Decimal(l.price).gt(startPrice),
    ).length;
    initialCash = investment.minus(quotePerLevel.times(sellLevelCount));
  }
  exchange.setCashBalance(initialCash);

  const config: GridBotConfig = {
    pair: "BTC-USD",
    levels: gridLevels,
    rangePct: rangePct.toString(),
    investment: investment.toString(),
    splitInvestment: split,
    intervalSec: 1,
    dryRun: false,
    reset: false,
    trailingUp,
    stopLoss:
      stopLossPrice > 0 ? new Decimal(stopLossPrice).toString() : undefined,
  };

  const bot = new ForegroundGridBot(config, {
    suppressDashboard: true,
    rateLimiter: PASSTHROUGH_RATE_LIMITER,
    persistState: false,
    orderConstraints: constraints,
  });
  const b = bot as unknown as Record<string, unknown>;
  b._client = exchange;
  b._state = state;
  b._pairInfo = null;
  b._connections = [];
  b._running = true;

  const fixedSlPrice = stopLossPrice > 0 ? new Decimal(stopLossPrice) : null;
  let peakValue = investment;

  // Add SPLIT entry to trade log
  if (split) {
    const sellLevelCount = state.levels.filter((l) =>
      new Decimal(l.price).gt(startPrice),
    ).length;
    if (sellLevelCount > 0) {
      const splitCost = quotePerLevel.times(sellLevelCount);
      result.tradeLog.push(
        `SPLIT: Market buy ${sellLevelCount} positions @ ${startPrice} | -${splitCost.toFixed(2)}`,
      );
    }
  }

  for (let tickIdx = 0; tickIdx < candles.length; tickIdx++) {
    const candle = candles[tickIdx];

    // Stop if bot already stopped (stop-loss in previous tick)
    if (!(b._running as boolean)) {
      break;
    }

    // Snapshot pre-tick metrics
    const prevBuys = state.stats.totalBuys;
    const prevSells = state.stats.totalSells;
    const prevPnl = new Decimal(state.stats.realizedPnl);
    const prevShiftCount = state.shiftCount ?? 0;
    const prevTradeLogLen = state.tradeLog.length;

    exchange.setPrice(candle.close);
    exchange.resetTickFills();

    await (b._tick as (p: Decimal) => Promise<void>).call(bot, candle.close);

    // Compute deltas
    const newBuys = state.stats.totalBuys - prevBuys;
    const newSells = state.stats.totalSells - prevSells;
    const pnlDelta = new Decimal(state.stats.realizedPnl).minus(prevPnl);
    const newShiftCount = state.shiftCount ?? 0;
    const shiftDelta = newShiftCount - prevShiftCount;

    result.totalBuys += newBuys;
    result.totalSells += newSells;
    result.totalTrades += newBuys + newSells;
    result.realizedPnl = result.realizedPnl.plus(pnlDelta);

    const botStopped = !(b._running as boolean);
    if (botStopped && fixedSlPrice) {
      result.stopLossTriggered = true;
    }

    if (shiftDelta > 0) {
      result.trailingUpShifts += shiftDelta;
    }

    // Build fills from exchange's per-tick tracking
    const tickFills: BacktestFill[] = [];
    for (const fill of exchange.filledBuys) {
      tickFills.push({
        side: "buy",
        price: fill.price,
        quantity: fill.quantity,
        quoteValue: fill.quoteValue,
        trigger: "grid",
      });
    }
    for (const fill of exchange.filledSells) {
      const trigger: BacktestFillTrigger = result.stopLossTriggered
        ? "stop-loss"
        : shiftDelta > 0
          ? "trailing-up"
          : "grid";
      tickFills.push({
        side: "sell",
        price: fill.price,
        quantity: fill.quantity,
        quoteValue: fill.quoteValue,
        trigger,
      });
    }

    // Append new trade log entries as strings
    const newEntries = state.tradeLog.slice(prevTradeLogLen);
    const tickBase = botTotalBaseHeld(state);
    const tickTotalPnl = exchange.cashBalance
      .plus(tickBase.times(candle.close))
      .minus(investment);
    const tickRoiPct = investment.isZero()
      ? new Decimal(0)
      : tickTotalPnl.div(investment).times(100);
    let runningRealized = result.realizedPnl.minus(pnlDelta);
    for (const entry of newEntries) {
      const isStopLoss = entry.orderId === "stop-loss";
      const sign = isStopLoss
        ? "STOP-LOSS SELL"
        : entry.side === "buy"
          ? "BUY "
          : "SELL";
      const profitStr =
        entry.profit !== undefined ? ` | profit=${entry.profit}` : "";
      result.tradeLog.push(
        `${sign} @ ${entry.price} | qty ${entry.quantity}${profitStr}`,
      );
      const price = new Decimal(entry.price);
      const quantity = new Decimal(entry.quantity);
      const profit =
        entry.profit !== undefined ? new Decimal(entry.profit) : undefined;
      if (profit !== undefined) runningRealized = runningRealized.plus(profit);
      const trigger: BacktestFillTrigger = isStopLoss
        ? "stop-loss"
        : shiftDelta > 0
          ? "trailing-up"
          : "grid";
      result.trades.push({
        index: result.trades.length + 1,
        side: entry.side,
        trigger,
        price,
        quantity,
        quoteValue: price.times(quantity),
        profit,
        realizedPnl: runningRealized,
        roiPct: tickRoiPct,
      });
    }

    if (shiftDelta > 0) {
      result.tradeLog.push(
        `TRAILING UP: Grid rebuilt around ${candle.close.toFixed(2)} (shift #${newShiftCount})`,
      );
    }

    // Drawdown using candle high/low
    const positionBase = botTotalBaseHeld(state);
    const highValue = exchange.cashBalance.plus(
      positionBase.times(candle.high),
    );
    peakValue = Decimal.max(peakValue, highValue);
    const lowValue = exchange.cashBalance.plus(positionBase.times(candle.low));
    if (peakValue.gt(0)) {
      const drawdown = peakValue.minus(lowValue).div(peakValue);
      result.maxDrawdown = Decimal.max(result.maxDrawdown, drawdown);
    }

    if (onTick) {
      const { position, costBasis } = botComputePosition(state);
      const cash = exchange.cashBalance;
      const markPrice = candle.close;
      const unrealized = position.times(markPrice).minus(costBasis);
      const totalValue = cash.plus(position.times(markPrice));
      const ts = typeof candle.start === "number" ? candle.start : Date.now();
      onTick({
        index: tickIdx,
        timestamp: ts,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        fills: tickFills,
        position,
        cash,
        realizedPnl: result.realizedPnl,
        unrealizedPnl: unrealized,
        totalValue,
      });
    }

    if (result.stopLossTriggered) {
      break;
    }
  }

  result.finalBase = botTotalBaseHeld(state);
  result.finalQuote = exchange.cashBalance;

  return result;
}
