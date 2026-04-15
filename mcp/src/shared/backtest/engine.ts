import { Decimal } from "decimal.js";

interface GridLevel {
  price: Decimal;
  index: number;
  hasBuyOrder: boolean;
  hasPosition: boolean;
  baseHeld: Decimal;
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
      hasBuyOrder: price.lt(startPrice),
      hasPosition: false,
      baseHeld: new Decimal(0),
    };
    levels.push(level);
  }

  return levels;
}

function sumBaseHeld(levels: GridLevel[]): Decimal {
  let total = new Decimal(0);
  for (const lv of levels) {
    total = total.plus(lv.baseHeld);
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
): Decimal {
  for (const level of levels) {
    if (level.hasBuyOrder && low.lte(level.price)) {
      const baseBought = quotePerLevel
        .div(level.price)
        .toDecimalPlaces(5, Decimal.ROUND_DOWN);

      level.hasBuyOrder = false;
      level.hasPosition = true;
      level.baseHeld = baseBought;

      quoteBalance = quoteBalance.minus(quotePerLevel);
      result.totalBuys += 1;
      result.totalTrades += 1;
      result.realizedPnl = result.realizedPnl.minus(quotePerLevel);

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
): Decimal {
  for (const level of levels) {
    if (level.hasPosition && level.index + 1 < levels.length) {
      const sellLevel = levels[level.index + 1];
      if (high.gte(sellLevel.price)) {
        const baseToSell = level.baseHeld;
        const quoteReceived = baseToSell
          .times(sellLevel.price)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);

        const profit = quoteReceived.minus(quotePerLevel);

        level.hasPosition = false;
        level.baseHeld = new Decimal(0);
        level.hasBuyOrder = true;

        quoteBalance = quoteBalance.plus(quoteReceived);
        result.totalSells += 1;
        result.totalTrades += 1;
        result.realizedPnl = result.realizedPnl.plus(quoteReceived);

        const totalPnl = quoteBalance
          .plus(sumBaseHeld(levels).times(sellLevel.price))
          .minus(investment);
        const roiPct = investment.isZero()
          ? new Decimal(0)
          : totalPnl.div(investment).times(100);

        result.tradeLog.push(
          `#${result.totalTrades}  SELL @ ${sellLevel.price} | qty ${baseToSell} | ` +
            `+${quoteReceived} | profit=${profit.toFixed(2)} | ` +
            `realized=${fmtPnl(result.realizedPnl)} | total=${fmtPnl(totalPnl)} | ROI=${fmtPnl(roiPct)}%`,
        );
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
    );
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
    );
  } else {
    quoteBalance = runBuyPass(
      levels,
      low,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
    );
    quoteBalance = runSellPass(
      levels,
      high,
      quotePerLevel,
      result,
      quoteBalance,
      investment,
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
): BacktestResult {
  if (candles.length === 0) {
    return createEmptyResult();
  }

  const startPrice = candles[0].open;
  const levels = createGrid(startPrice, gridLevels, rangePct);

  let buyLevelCount = 0;
  for (const lv of levels) {
    if (lv.hasBuyOrder) buyLevelCount++;
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
        buyLevel.hasPosition = true;
        buyLevel.hasBuyOrder = false;
        buyLevel.baseHeld = basePerLevel;
      }
    }

    const splitCost = quotePerLevel.times(sellLevelIndices.length);
    quoteBalance = quoteBalance.minus(splitCost);
    result.totalBuys += sellLevelIndices.length;
    result.totalTrades += sellLevelIndices.length;
    result.realizedPnl = result.realizedPnl.minus(splitCost);

    const totalPnl = quoteBalance
      .plus(sumBaseHeld(levels).times(startPrice))
      .minus(investment);

    result.tradeLog.push(
      `SPLIT: Market buy ${sellLevelIndices.length} positions @ ${startPrice} | ` +
        `-${splitCost.toFixed(2)} | realized=${fmtPnl(result.realizedPnl)} | total=${fmtPnl(totalPnl)}`,
    );
  }

  for (const candle of candles) {
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
    );

    let totalBaseHeld = new Decimal(0);
    for (const lv of levels) {
      totalBaseHeld = totalBaseHeld.plus(lv.baseHeld);
    }
    const highValue = quoteBalance.plus(totalBaseHeld.times(candle.high));
    peakValue = Decimal.max(peakValue, highValue);
    const lowValue = quoteBalance.plus(totalBaseHeld.times(candle.low));
    if (peakValue.gt(0)) {
      const drawdown = peakValue.minus(lowValue).div(peakValue);
      result.maxDrawdown = Decimal.max(result.maxDrawdown, drawdown);
    }
  }

  let finalBase = new Decimal(0);
  for (const lv of levels) {
    finalBase = finalBase.plus(lv.baseHeld);
  }
  result.finalBase = finalBase;
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
  const results: OptimizationResult[] = [];

  for (const levels of gridLevelsRange) {
    for (const rangePct of rangePctRange) {
      const bt = runBacktest(candles, levels, rangePct, investment, split);

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
