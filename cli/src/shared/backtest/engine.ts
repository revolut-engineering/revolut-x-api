import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { ForegroundGridBot } from "../../engine/grid-bot.js";
import type { GridBotConfig } from "../../engine/grid-bot.js";
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
  positions: Decimal[]; // baseHeld for each open position
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
  trailingUpShifts: number;
  stopLossTriggered: boolean;
}

export type BacktestFillTrigger = "grid" | "stop-loss" | "trailing-up";

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
    trailingUpShifts: 0,
    stopLossTriggered: false,
  };
}

export function createGrid(
  startPrice: Decimal,
  gridLevels: number,
  rangePct: Decimal,
): GridLevel[] {
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const ratio = upper.div(lower).pow(new Decimal(1).div(gridLevels - 1));

  const levels: GridLevel[] = [];
  for (let i = 0; i < gridLevels; i++) {
    const price = lower.times(ratio.pow(i)).toDecimalPlaces(2);
    const level: GridLevel = {
      price,
      index: i,
      buyCount: price.lt(startPrice) ? 1 : 0,
      positions: [],
    };
    levels.push(level);
  }

  return levels;
}

function sumBaseHeld(levels: GridLevel[]): Decimal {
  let total = new Decimal(0);
  for (const lv of levels) {
    for (const baseHeld of lv.positions) {
      total = total.plus(baseHeld);
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
    for (const baseHeld of lv.positions) {
      position = position.plus(baseHeld);
      costBasis = costBasis.plus(baseHeld.times(lv.price));
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
): Decimal {
  for (const level of levels) {
    if (level.buyCount > 0 && low.lte(level.price)) {
      const baseBought = quotePerLevel
        .div(level.price)
        .toDecimalPlaces(5, Decimal.ROUND_DOWN);

      for (let i = 0; i < level.buyCount; i++) {
        level.positions.push(baseBought);
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
): Decimal {
  for (const level of levels) {
    if (level.positions.length > 0 && level.index + 1 < levels.length) {
      const sellLevel = levels[level.index + 1];
      if (high.gte(sellLevel.price)) {
        const positionsToSell = level.positions.splice(0);

        for (const baseHeld of positionsToSell) {
          const quoteReceived = baseHeld
            .times(sellLevel.price)
            .toDecimalPlaces(2, Decimal.ROUND_DOWN);
          const profit = quoteReceived.minus(quotePerLevel);

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
    );
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
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
    );
    quoteBalance = runSellPass(
      levels,
      high,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      tickFills,
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
): BacktestResult {
  if (candles.length === 0) {
    return createEmptyResult();
  }

  const startPrice = candles[0].open;
  const levels = createGrid(startPrice, gridLevels, rangePct);

  let buyLevelCount = 0;
  for (const lv of levels) {
    if (lv.buyCount > 0) buyLevelCount++;
  }

  const sellLevelIndices: number[] = [];
  if (split) {
    for (const lv of levels) {
      if (lv.price.gt(startPrice)) {
        sellLevelIndices.push(lv.index);
      }
    }
  }

  const totalCapitalLevels = split
    ? buyLevelCount + sellLevelIndices.length
    : buyLevelCount;

  const quotePerLevel = investment
    .div(Math.max(totalCapitalLevels, 1))
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);

  const result = createEmptyResult();
  let quoteBalance = investment;
  let peakValue = investment;

  if (split && sellLevelIndices.length > 0) {
    const basePerLevel = quotePerLevel
      .div(startPrice)
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);

    for (const sellIdx of sellLevelIndices) {
      const buyLevel = levels[sellIdx - 1];
      if (buyLevel) {
        buyLevel.positions.push(basePerLevel);
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
          const baseHeld = level.positions.pop()!;
          const quoteReceived = baseHeld
            .times(fixedSlPrice)
            .toDecimalPlaces(2, Decimal.ROUND_DOWN);
          const profit = quoteReceived.minus(quotePerLevel);
          quoteBalance = quoteBalance.plus(quoteReceived);
          result.realizedPnl = result.realizedPnl.plus(profit);
          result.totalSells++;
          result.totalTrades++;
          result.tradeLog.push(
            `#${result.totalTrades}  STOP-LOSS SELL @ ${fixedSlPrice.toFixed(2)} | qty ${baseHeld.toFixed(5)} | ` +
              `+${quoteReceived.toFixed(2)} | profit=${profit.toFixed(2)}`,
          );
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
    );

    // Trailing up check: did the candle's high breach the upper boundary + one step?
    if (trailingUp) {
      const upper = levels[levels.length - 1].price;
      const lower = levels[0].price;
      const ratio = upper.div(lower).pow(new Decimal(1).div(levels.length - 1));
      if (
        candle.high.gte(
          upper
            .times(ratio)
            .plus(upper.times(ratio.pow(2)))
            .div(2),
        )
      ) {
        const rebuildPrice = candle.close;

        // Save buyCount before sell pass clears things (used to restore split slots)
        const savedBuyCounts = levels.map((l) => l.buyCount);

        // Sell all held positions at the rebuild price
        for (const level of levels) {
          while (level.positions.length > 0) {
            const baseHeld = level.positions.pop()!;
            const quoteReceived = baseHeld
              .times(rebuildPrice)
              .toDecimalPlaces(2, Decimal.ROUND_DOWN);
            const profit = quoteReceived.minus(quotePerLevel);
            quoteBalance = quoteBalance.plus(quoteReceived);
            result.realizedPnl = result.realizedPnl.plus(profit);
            result.totalSells++;
            result.totalTrades++;
            result.tradeLog.push(
              `#${result.totalTrades}  TRAILING-UP SELL @ ${rebuildPrice.toFixed(2)} | ` +
                `profit=${profit.toFixed(2)}`,
            );
            tickFills.push({
              side: "sell",
              price: rebuildPrice,
              quantity: baseHeld,
              quoteValue: quoteReceived,
              profit,
              trigger: "trailing-up",
            });
          }
        }

        // Shift the grid by ratio^k steps (preserves geometric spacing)
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
        for (let i = 0; i < levels.length; i++) {
          levels[i].price = levels[i].price
            .times(ratioK)
            .toDecimalPlaces(2, Decimal.ROUND_DOWN);
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
): OptimizationResult[] {
  if (candles.length === 0) {
    return [];
  }

  if (!gridLevelsRange) {
    gridLevelsRange = [5, 8, 10, 12, 15, 20, 25, 30];
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

  const finalPrice = candles[candles.length - 1].close;
  const startPrice = candles[0].open;
  const results: OptimizationResult[] = [];

  for (const levels of gridLevelsRange) {
    for (const rangePct of rangePctRange) {
      // Skip combinations where the stop-loss sits inside the grid: the SL
      // would fire during normal oscillation and produce meaningless results.
      if (stopLossPrice > 0) {
        const lowestLevel = startPrice.times(new Decimal(1).minus(rangePct));
        if (new Decimal(stopLossPrice).gte(lowestLevel)) {
          continue;
        }
      }

      const bt = runBacktest(
        candles,
        levels,
        rangePct,
        investment,
        split,
        trailingUp,
        stopLossPrice,
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
): { state: GridState; quotePerLevel: Decimal } {
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const ratio = upper.div(lower).pow(new Decimal(1).div(gridLevels - 1));

  const levels: GridLevelState[] = [];
  for (let i = 0; i < gridLevels; i++) {
    const price = lower
      .times(ratio.pow(i))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    levels.push({
      index: i,
      price: price.toString(),
      buyOrderIds: [],
      positions: [],
    });
  }

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

  const totalCapitalLevels = split
    ? buyLevelsList.length + sellLevelIndices.length
    : buyLevelsList.length;

  const quotePerLevel = investment
    .div(Math.max(totalCapitalLevels, 1))
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);

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
    quotePrecision: "0.01",
    basePrecision: "0.00001",
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
    const basePerLevel = quotePerLevel
      .div(startPrice)
      .toDecimalPlaces(5, Decimal.ROUND_DOWN);

    for (const sellIdx of sellLevelIndices) {
      const buyLevel = levels[sellIdx - 1];
      const sellLevel = levels[sellIdx];
      if (!buyLevel || !sellLevel) continue;

      const sellId = `init-sell-${sellIdx}-${randomUUID().slice(0, 4)}`;
      const pos: GridLevelPosition = {
        id: `split-${sellIdx}`,
        baseHeld: basePerLevel.toString(),
        fillCost: quotePerLevel.toFixed(2),
        sellOrderId: sellId,
      };
      buyLevel.positions.push(pos);

      exchange.seedOrder({
        id: sellId,
        side: "sell",
        type: "limit",
        price: new Decimal(sellLevel.price),
        baseSize: basePerLevel,
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
): Promise<BacktestResult> {
  if (candles.length === 0) {
    return createEmptyResult();
  }

  const result = createEmptyResult();
  const startPrice = candles[0].open;
  const exchange = new SimulatedExchange();

  const { state, quotePerLevel } = buildBotInitialState(
    startPrice,
    gridLevels,
    rangePct,
    investment,
    split,
    trailingUp,
    stopLossPrice,
    exchange,
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

  const bot = new ForegroundGridBot(config, { suppressDashboard: true });
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
