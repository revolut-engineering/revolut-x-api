import { Decimal } from "decimal.js";

export interface GridLevel {
  price: Decimal;
  index: number;
  hasBuyOrder: boolean;
  hasPosition: boolean;
  btcHeld: Decimal;
}

export interface BacktestResult {
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  totalFees: Decimal;
  realizedPnl: Decimal;
  finalBtc: Decimal;
  finalUsd: Decimal;
  maxDrawdown: Decimal;
  tradeLog: string[];
}

export interface OptimizationResult {
  gridLevels: number;
  rangePct: Decimal;
  investment: Decimal;
  totalReturn: Decimal;
  returnPct: Decimal;
  totalTrades: number;
  maxDrawdown: Decimal;
  profitPerTrade: Decimal;
  sharpeApprox: Decimal;
}

function createEmptyResult(): BacktestResult {
  return {
    totalTrades: 0,
    totalBuys: 0,
    totalSells: 0,
    totalFees: new Decimal(0),
    realizedPnl: new Decimal(0),
    finalBtc: new Decimal(0),
    finalUsd: new Decimal(0),
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
  const step = upper.minus(lower).div(gridLevels - 1);

  const levels: GridLevel[] = [];
  for (let i = 0; i < gridLevels; i++) {
    const price = lower.plus(step.times(i)).toDecimalPlaces(2);
    const level: GridLevel = {
      price,
      index: i,
      hasBuyOrder: price.lt(startPrice),
      hasPosition: false,
      btcHeld: new Decimal(0),
    };
    levels.push(level);
  }

  return levels;
}

export function simulateCandle(
  levels: GridLevel[],
  low: Decimal,
  high: Decimal,
  usdPerLevel: Decimal,
  result: BacktestResult,
  usdBalance: Decimal,
  gridLevels: number,
  feeRate: Decimal = new Decimal(0),
): Decimal {
  for (const level of levels) {
    if (level.hasBuyOrder && low.lte(level.price)) {
      const btcBought = usdPerLevel
        .div(level.price)
        .toDecimalPlaces(5, Decimal.ROUND_DOWN);
      const fee = usdPerLevel.times(feeRate);

      level.hasBuyOrder = false;
      level.hasPosition = true;
      level.btcHeld = btcBought;

      usdBalance = usdBalance.minus(usdPerLevel);
      result.totalBuys += 1;
      result.totalTrades += 1;
      result.totalFees = result.totalFees.plus(fee);
      result.tradeLog.push(
        `BUY  @ $${level.price} | ${btcBought} BTC | -$${usdPerLevel}`,
      );
    }
  }

  for (const level of levels) {
    if (level.hasPosition && level.index < gridLevels - 1) {
      const sellLevel = levels[level.index + 1];
      if (high.gte(sellLevel.price)) {
        const btcToSell = level.btcHeld;
        const usdReceived = btcToSell
          .times(sellLevel.price)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const fee = usdReceived.times(feeRate);

        const costBasis = btcToSell.times(level.price);
        const profit = usdReceived.minus(costBasis).minus(fee);

        level.hasPosition = false;
        level.btcHeld = new Decimal(0);
        level.hasBuyOrder = true;

        usdBalance = usdBalance.plus(usdReceived);
        result.totalSells += 1;
        result.totalTrades += 1;
        result.totalFees = result.totalFees.plus(fee);
        result.realizedPnl = result.realizedPnl.plus(profit);
        result.tradeLog.push(
          `SELL @ $${sellLevel.price} | ${btcToSell} BTC | ` +
            `+$${usdReceived} | profit=$${profit.toFixed(2)}`,
        );
      }
    }
  }

  return usdBalance;
}

export function runBacktest(
  candles: Array<Record<string, Decimal>>,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  feeRate: Decimal = new Decimal(0),
): BacktestResult {
  if (candles.length === 0) {
    return createEmptyResult();
  }

  const startPrice = candles[0].close;
  const levels = createGrid(startPrice, gridLevels, rangePct);

  let buyLevels = 0;
  for (const lv of levels) {
    if (lv.hasBuyOrder) buyLevels++;
  }
  const usdPerLevel = investment
    .div(Math.max(buyLevels, 1))
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);

  const result = createEmptyResult();
  let usdBalance = investment;
  let peakValue = investment;

  for (const candle of candles) {
    usdBalance = simulateCandle(
      levels,
      candle.low,
      candle.high,
      usdPerLevel,
      result,
      usdBalance,
      gridLevels,
      feeRate,
    );

    let btcValue = new Decimal(0);
    for (const lv of levels) {
      btcValue = btcValue.plus(lv.btcHeld.times(candle.close));
    }
    const totalValue = usdBalance.plus(btcValue);
    peakValue = Decimal.max(peakValue, totalValue);
    if (peakValue.gt(0)) {
      const drawdown = peakValue.minus(totalValue).div(peakValue);
      result.maxDrawdown = Decimal.max(result.maxDrawdown, drawdown);
    }
  }

  let finalBtc = new Decimal(0);
  for (const lv of levels) {
    finalBtc = finalBtc.plus(lv.btcHeld);
  }
  result.finalBtc = finalBtc;
  result.finalUsd = usdBalance;

  return result;
}

export function optimizeGridParams(
  candles: Array<Record<string, Decimal>>,
  gridLevelsRange?: number[],
  rangePctRange?: Decimal[],
  investment: Decimal = new Decimal(1000),
  feeRate: Decimal = new Decimal(0),
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
      const bt = runBacktest(candles, levels, rangePct, investment, feeRate);

      const totalValue = bt.finalUsd.plus(bt.finalBtc.times(finalPrice));
      const totalReturn = totalValue.minus(investment);
      const returnPct = investment.isZero()
        ? new Decimal(0)
        : totalReturn.div(investment).times(100);

      const profitPerTrade =
        bt.totalSells > 0 ? bt.realizedPnl.div(bt.totalSells) : new Decimal(0);

      const sharpe = bt.maxDrawdown.gt(0)
        ? returnPct.div(bt.maxDrawdown.times(100))
        : returnPct;

      results.push({
        gridLevels: levels,
        rangePct,
        investment,
        totalReturn,
        returnPct,
        totalTrades: bt.totalTrades,
        maxDrawdown: bt.maxDrawdown,
        profitPerTrade,
        sharpeApprox: sharpe,
      });
    }
  }

  results.sort((a, b) => b.totalReturn.cmp(a.totalReturn));
  return results;
}
