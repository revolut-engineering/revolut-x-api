import { Decimal } from "decimal.js";

interface GridLevel {
  price: Decimal;
  index: number;
  buyCount: number; // pending buy orders at this level
  positions: Decimal[]; // baseHeld for each open position
}

export interface BacktestResult {
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

export interface OptimizationResult {
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
  quoteDp = 2,
): GridLevel[] {
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const ratio = upper.div(lower).pow(new Decimal(1).div(gridLevels - 1));

  const levels: GridLevel[] = [];
  for (let i = 0; i < gridLevels; i++) {
    const price = lower.times(ratio.pow(i)).toDecimalPlaces(quoteDp);
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

function runBuyPass(
  levels: GridLevel[],
  low: Decimal,
  quotePerLevel: Decimal,
  result: BacktestResult,
  quoteBalance: Decimal,
  investment: Decimal,
  baseDp = 5,
): Decimal {
  for (const level of levels) {
    if (level.buyCount > 0 && low.lte(level.price)) {
      const baseBought = quotePerLevel
        .div(level.price)
        .toDecimalPlaces(baseDp, Decimal.ROUND_DOWN);

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
  quoteDp = 2,
): Decimal {
  for (const level of levels) {
    if (level.positions.length > 0 && level.index + 1 < levels.length) {
      const sellLevel = levels[level.index + 1];
      if (high.gte(sellLevel.price)) {
        const positionsToSell = level.positions.splice(0);

        for (const baseHeld of positionsToSell) {
          const quoteReceived = baseHeld
            .times(sellLevel.price)
            .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
          const profit = quoteReceived.minus(quotePerLevel);

          level.buyCount++;
          quoteBalance = quoteBalance.plus(quoteReceived);
          result.totalSells += 1;
          result.totalTrades += 1;
          result.realizedPnl = result.realizedPnl.plus(profit);

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
  baseDp = 5,
  quoteDp = 2,
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
      quoteDp,
    );
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      baseDp,
    );
  } else {
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      baseDp,
    );
    quoteBalance = runSellPass(
      levels,
      high,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
      quoteDp,
    );
  }

  return quoteBalance;
}

export function runBacktest(
  candles: Array<Record<string, Decimal>>,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  split = false,
  trailingUp = false,
  stopLossPrice = 0,
  baseStep = new Decimal("0.00001"),
  quoteStep = new Decimal("0.01"),
): BacktestResult {
  const baseDp = baseStep.decimalPlaces() ?? 5;
  const quoteDp = quoteStep.decimalPlaces() ?? 2;
  if (candles.length === 0) {
    return createEmptyResult();
  }

  const startPrice = candles[0].open;
  const levels = createGrid(startPrice, gridLevels, rangePct, quoteDp);

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
      .toDecimalPlaces(baseDp, Decimal.ROUND_DOWN);

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

  for (const candle of candles) {
    // Stop-loss check: did the candle's low breach the fixed threshold?
    if (fixedSlPrice && candle.low.lte(fixedSlPrice)) {
      // Simulate market sell of all held positions at the stop-loss price
      for (const level of levels) {
        while (level.positions.length > 0) {
          const baseHeld = level.positions.pop()!;
          const quoteReceived = baseHeld
            .times(fixedSlPrice)
            .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
          const profit = quoteReceived.minus(quotePerLevel);
          quoteBalance = quoteBalance.plus(quoteReceived);
          result.realizedPnl = result.realizedPnl.plus(profit);
          result.totalSells++;
          result.totalTrades++;
          result.tradeLog.push(
            `#${result.totalTrades}  STOP-LOSS SELL @ ${fixedSlPrice.toFixed(2)} | qty ${baseHeld.toFixed(5)} | ` +
              `+${quoteReceived.toFixed(2)} | profit=${profit.toFixed(2)}`,
          );
        }
      }
      result.stopLossTriggered = true;
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
      baseDp,
      quoteDp,
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
              .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
            const profit = quoteReceived.minus(quotePerLevel);
            quoteBalance = quoteBalance.plus(quoteReceived);
            result.realizedPnl = result.realizedPnl.plus(profit);
            result.totalSells++;
            result.totalTrades++;
            result.tradeLog.push(
              `#${result.totalTrades}  TRAILING-UP SELL @ ${rebuildPrice.toFixed(2)} | ` +
                `profit=${profit.toFixed(2)}`,
            );
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
            .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
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
        // quotePerLevel is preserved (not recalculated), matching CLI behaviour

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
  }

  result.finalBase = sumBaseHeld(levels);
  result.finalQuote = quoteBalance;

  return result;
}

export function optimizeGridParams(
  candles: Array<Record<string, Decimal>>,
  gridLevelsRange?: number[],
  rangePctRange?: Decimal[],
  investment: Decimal = new Decimal(1000),
  days: number = 30,
  split = false,
  trailingUp = false,
  stopLossPrice = 0,
  baseStep = new Decimal("0.00001"),
  quoteStep = new Decimal("0.01"),
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
        baseStep,
        quoteStep,
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
