import { Decimal } from "decimal.js";

export interface MartingaleBacktestParams {
  priceDeviation: Decimal;
  safetyOrderVolumeScale: Decimal;
  maxSafetyOrders: number;
  takeProfit: Decimal;
  stopLoss: Decimal;
  investment: Decimal;
}

export interface MartingaleBacktestResult {
  completedCycles: number;
  winningCycles: number;
  stopLossCount: number;
  totalTrades: number;
  realizedPnl: Decimal;
  finalBase: Decimal;
  finalCost: Decimal;
  maxDrawdown: Decimal;
  totalReturn: Decimal;
  returnPct: Decimal;
  tradeLog: string[];
}

export interface MartingaleOptimizationResult {
  priceDeviation: Decimal;
  safetyOrderVolumeScale: Decimal;
  maxSafetyOrders: number;
  takeProfit: Decimal;
  realizedPnl: Decimal;
  totalReturn: Decimal;
  returnPct: Decimal;
  completedCycles: number;
  stopLossCount: number;
  maxDrawdown: Decimal;
}

export interface BacktestCandle {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  start?: number;
}

function computeBaseOrderPct(scale: Decimal, maxSafetyOrders: number): Decimal {
  const n = maxSafetyOrders + 1;
  if (scale.minus(1).abs().lt(new Decimal("1e-9"))) {
    return new Decimal(1).div(n);
  }
  return scale.minus(1).div(scale.pow(n).minus(1));
}

function buildLevels(
  entryPrice: Decimal,
  params: MartingaleBacktestParams,
): Array<{ price: Decimal; quoteSize: Decimal; filled: boolean }> {
  const {
    priceDeviation,
    safetyOrderVolumeScale,
    maxSafetyOrders,
    investment,
  } = params;
  const basePct = computeBaseOrderPct(safetyOrderVolumeScale, maxSafetyOrders);
  const levels: Array<{ price: Decimal; quoteSize: Decimal; filled: boolean }> =
    [];
  for (let i = 0; i <= maxSafetyOrders; i++) {
    const price = entryPrice
      .times(new Decimal(1).minus(priceDeviation).pow(i + 1))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const quoteSize = investment
      .times(basePct)
      .times(safetyOrderVolumeScale.pow(i))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    levels.push({ price, quoteSize, filled: false });
  }
  return levels;
}

interface CycleState {
  inPosition: boolean;
  safetyOrdersFilled: number;
  totalQty: Decimal;
  totalCost: Decimal;
  avgEntryPrice: Decimal;
  tpPrice: Decimal | null;
  slPrice: Decimal | null;
  levels: Array<{ price: Decimal; quoteSize: Decimal; filled: boolean }>;
}

function initCycle(
  entryPrice: Decimal,
  params: MartingaleBacktestParams,
): CycleState {
  const slPrice = entryPrice
    .times(new Decimal(1).minus(params.stopLoss))
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return {
    inPosition: false,
    safetyOrdersFilled: 0,
    totalQty: new Decimal(0),
    totalCost: new Decimal(0),
    avgEntryPrice: new Decimal(0),
    tpPrice: null,
    slPrice,
    levels: buildLevels(entryPrice, params),
  };
}

function resetCycle(state: CycleState): void {
  state.inPosition = false;
  state.safetyOrdersFilled = 0;
  state.totalQty = new Decimal(0);
  state.totalCost = new Decimal(0);
  state.avgEntryPrice = new Decimal(0);
  state.tpPrice = null;
  state.slPrice = null;
  for (const l of state.levels) l.filled = false;
}

export function runMartingaleBacktest(
  candles: BacktestCandle[],
  params: MartingaleBacktestParams,
): MartingaleBacktestResult {
  if (candles.length === 0) {
    return {
      completedCycles: 0,
      winningCycles: 0,
      stopLossCount: 0,
      totalTrades: 0,
      realizedPnl: new Decimal(0),
      finalBase: new Decimal(0),
      finalCost: new Decimal(0),
      maxDrawdown: new Decimal(0),
      totalReturn: new Decimal(0),
      returnPct: new Decimal(0),
      tradeLog: [],
    };
  }

  const { takeProfit, stopLoss } = params;
  const tradeLog: string[] = [];
  let completedCycles = 0;
  let winningCycles = 0;
  let stopLossCount = 0;
  let totalTrades = 0;
  let realizedPnl = new Decimal(0);
  let maxDrawdown = new Decimal(0);
  let peakValue = params.investment;
  let stopped = false;

  let state = initCycle(candles[0].close, params);

  for (let i = 0; i < candles.length; i++) {
    if (stopped) break;
    const { high, low, close, open } = candles[i];
    const bearish = close.lt(open);
    const dateStr = candles[i].start
      ? new Date(candles[i].start!).toISOString().slice(0, 10)
      : String(i);

    const runBuys = () => {
      for (const level of state.levels) {
        if (level.filled) continue;
        if (!low.lte(level.price)) continue;
        const isInitial = !state.inPosition;
        const qty = level.quoteSize
          .div(level.price)
          .toDecimalPlaces(5, Decimal.ROUND_DOWN);
        level.filled = true;
        state.totalQty = state.totalQty.plus(qty);
        state.totalCost = state.totalCost.plus(level.quoteSize);
        state.avgEntryPrice = state.totalCost.div(state.totalQty);
        if (isInitial) {
          state.inPosition = true;
        } else {
          state.safetyOrdersFilled++;
        }
        state.tpPrice = state.avgEntryPrice
          .times(new Decimal(1).plus(takeProfit))
          .toDecimalPlaces(2, Decimal.ROUND_UP);
        totalTrades++;
        tradeLog.push(
          `${dateStr} BUY  $${level.price.toFixed(2)} qty=${qty.toFixed(5)} [${isInitial ? "INITIAL" : `SO#${state.safetyOrdersFilled}`}] avgEntry=$${state.avgEntryPrice.toFixed(2)}`,
        );
      }
    };

    const runSells = () => {
      if (!state.inPosition) return;
      if (state.slPrice && low.lte(state.slPrice)) {
        const revenue = state.totalQty
          .times(state.slPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(state.totalCost);
        realizedPnl = realizedPnl.plus(profit);
        stopLossCount++;
        completedCycles++;
        totalTrades++;
        tradeLog.push(
          `${dateStr} SELL $${state.slPrice.toFixed(2)} qty=${state.totalQty.toFixed(5)} [STOP-LOSS] pnl=${profit.gte(0) ? "+" : ""}${profit.toFixed(2)}`,
        );
        resetCycle(state);
        stopped = true;
        return;
      }
      if (state.tpPrice && high.gte(state.tpPrice)) {
        const revenue = state.totalQty
          .times(state.tpPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(state.totalCost);
        realizedPnl = realizedPnl.plus(profit);
        completedCycles++;
        if (profit.gt(0)) winningCycles++;
        totalTrades++;
        tradeLog.push(
          `${dateStr} SELL $${state.tpPrice.toFixed(2)} qty=${state.totalQty.toFixed(5)} [TP] profit=+${profit.toFixed(2)}`,
        );
        state = initCycle(close, params);
      }
    };

    if (bearish) {
      runSells();
      if (!stopped) runBuys();
    } else {
      runBuys();
      runSells();
    }

    const unrealized = state.inPosition
      ? state.totalQty.times(close).minus(state.totalCost)
      : new Decimal(0);
    const totalValue = params.investment.plus(realizedPnl).plus(unrealized);
    if (totalValue.gt(peakValue)) peakValue = totalValue;
    const dd = peakValue.minus(totalValue);
    if (dd.gt(maxDrawdown)) maxDrawdown = dd;
  }

  const lastClose = candles[candles.length - 1].close;
  const finalUnrealized = state.inPosition
    ? state.totalQty.times(lastClose).minus(state.totalCost)
    : new Decimal(0);
  const totalReturn = realizedPnl.plus(finalUnrealized);
  const returnPct = params.investment.gt(0)
    ? totalReturn.div(params.investment).times(100)
    : new Decimal(0);

  return {
    completedCycles,
    winningCycles,
    stopLossCount,
    totalTrades,
    realizedPnl,
    finalBase: state.totalQty,
    finalCost: state.totalCost,
    maxDrawdown,
    totalReturn,
    returnPct,
    tradeLog,
  };
}

export function optimizeMartingaleParams(
  candles: BacktestCandle[],
  investment: Decimal,
  stopLoss: Decimal,
  maxCombinations = 200,
): MartingaleOptimizationResult[] {
  const priceDeviations = [
    new Decimal("0.01"),
    new Decimal("0.015"),
    new Decimal("0.02"),
    new Decimal("0.025"),
    new Decimal("0.03"),
  ];
  const scales = [new Decimal("1.5"), new Decimal("2.0"), new Decimal("2.5")];
  const maxSafetyOrdersList = [3, 5, 7];
  const takeProfits = [
    new Decimal("0.01"),
    new Decimal("0.015"),
    new Decimal("0.02"),
    new Decimal("0.025"),
  ];

  const combinations: MartingaleBacktestParams[] = [];
  outer: for (const dev of priceDeviations) {
    for (const scale of scales) {
      for (const maxSO of maxSafetyOrdersList) {
        for (const tp of takeProfits) {
          // SL is measured from entryPrice (above all levels), so lowest level is at (1-dev)^(N+1)
          const minSlRequired = new Decimal(1).minus(
            new Decimal(1).minus(dev).pow(maxSO + 1),
          );
          if (stopLoss.lte(minSlRequired)) continue;
          combinations.push({
            priceDeviation: dev,
            safetyOrderVolumeScale: scale,
            maxSafetyOrders: maxSO,
            takeProfit: tp,
            stopLoss,
            investment,
          });
          if (combinations.length >= maxCombinations) break outer;
        }
      }
    }
  }

  return combinations
    .map((params) => {
      const r = runMartingaleBacktest(candles, params);
      return {
        priceDeviation: params.priceDeviation,
        safetyOrderVolumeScale: params.safetyOrderVolumeScale,
        maxSafetyOrders: params.maxSafetyOrders,
        takeProfit: params.takeProfit,
        realizedPnl: r.realizedPnl,
        totalReturn: r.totalReturn,
        returnPct: r.returnPct,
        completedCycles: r.completedCycles,
        stopLossCount: r.stopLossCount,
        maxDrawdown: r.maxDrawdown,
      };
    })
    .sort((a, b) => b.totalReturn.minus(a.totalReturn).toNumber());
}
