import { Decimal } from "decimal.js";
import type { BacktestCandle } from "./engine.js";
import { computeBaseOrderPct } from "../../engine/martingale-bot.js";

export interface MartingaleBacktestParams {
  priceDeviation: Decimal;
  safetyOrderVolumeScale: Decimal;
  maxSafetyOrders: number;
  takeProfit: Decimal;
  stopLoss: Decimal;
  investment: Decimal;
  /** Real exchange base step (e.g. 0.00000001 for BTC). Defaults to 0.00001. */
  baseStep?: Decimal;
  /** Real exchange quote step (price increment, e.g. 0.01 for BTC-USD). Defaults to 0.01. */
  quoteStep?: Decimal;
  /** Real exchange minimum order size in quote currency. Defaults to 0 (not checked). */
  minOrderSizeQuote?: Decimal;
}

export interface MartingaleTrade {
  index: number;
  side: "buy" | "sell";
  label: string; // [INITIAL], [SO#1], [TP], [STOP-LOSS]
  price: Decimal;
  quantity: Decimal;
  quoteValue: Decimal;
  profit?: Decimal;
  realizedPnl: Decimal;
  roiPct: Decimal;
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
  trades: MartingaleTrade[];
}

export interface MartingaleBacktestTickEvent {
  index: number;
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalValue: Decimal;
  totalQty: Decimal;
  cash: Decimal;
  inPosition: boolean;
  safetyOrdersFilled: number;
  cycle: number;
  tickFills: string[];
}

export type MartingaleBacktestOnTick = (
  event: MartingaleBacktestTickEvent,
) => void;

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
  calmarApprox: Decimal;
}

interface CycleState {
  inPosition: boolean;
  safetyOrdersFilled: number;
  totalQty: Decimal;
  totalCost: Decimal;
  avgEntryPrice: Decimal;
  initialBuyPrice: Decimal | null;
  tpPrice: Decimal | null;
  slPrice: Decimal | null;
  levels: Array<{ price: Decimal; quoteSize: Decimal; filled: boolean }>;
}

function buildLevels(
  entryPrice: Decimal,
  params: MartingaleBacktestParams,
  quoteDp: number,
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
    // Level 0 is the market entry at current price.
    // Levels 1..maxSO are limit safety orders at entryPrice × (1−dev)^i.
    const price =
      i === 0
        ? entryPrice.toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN)
        : entryPrice
            .times(new Decimal(1).minus(priceDeviation).pow(i))
            .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
    const quoteSize = investment
      .times(basePct)
      .times(safetyOrderVolumeScale.pow(i))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    levels.push({ price, quoteSize, filled: false });
  }
  return levels;
}

function initCycle(
  entryPrice: Decimal,
  params: MartingaleBacktestParams,
  quoteDp: number,
): CycleState {
  const slPrice = entryPrice
    .times(new Decimal(1).minus(params.stopLoss))
    .toDecimalPlaces(quoteDp, Decimal.ROUND_DOWN);
  return {
    inPosition: false,
    safetyOrdersFilled: 0,
    totalQty: new Decimal(0),
    totalCost: new Decimal(0),
    avgEntryPrice: new Decimal(0),
    initialBuyPrice: null,
    tpPrice: null,
    slPrice,
    levels: buildLevels(entryPrice, params, quoteDp),
  };
}

// Apply the market entry for level[0] immediately on cycle start.
// Returns the fill details so the caller can update totalTrades / tradeLog / trades.
function applyMarketEntryToState(
  state: CycleState,
  entryPrice: Decimal,
  params: MartingaleBacktestParams,
  baseDp: number,
  quoteDp: number,
): { qty: Decimal; quoteSize: Decimal } {
  const level = state.levels[0];
  const qty = level.quoteSize
    .div(entryPrice)
    .toDecimalPlaces(baseDp, Decimal.ROUND_DOWN);
  level.filled = true;
  state.totalQty = qty;
  state.totalCost = level.quoteSize;
  state.avgEntryPrice = qty.gt(0) ? state.totalCost.div(qty) : entryPrice;
  state.inPosition = true;
  state.initialBuyPrice = entryPrice;
  state.tpPrice = state.avgEntryPrice
    .times(new Decimal(1).plus(params.takeProfit))
    .toDecimalPlaces(quoteDp, Decimal.ROUND_UP);
  return { qty, quoteSize: level.quoteSize };
}

function resetCycleState(state: CycleState): void {
  state.inPosition = false;
  state.safetyOrdersFilled = 0;
  state.totalQty = new Decimal(0);
  state.totalCost = new Decimal(0);
  state.avgEntryPrice = new Decimal(0);
  state.initialBuyPrice = null;
  state.tpPrice = null;
  state.slPrice = null;
  for (const l of state.levels) l.filled = false;
}

export function runMartingaleBacktest(
  candles: BacktestCandle[],
  params: MartingaleBacktestParams,
  onTick?: MartingaleBacktestOnTick,
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
      trades: [],
    };
  }

  const { takeProfit } = params;
  const tradeLog: string[] = [];
  const trades: MartingaleTrade[] = [];
  let completedCycles = 0;
  let winningCycles = 0;
  let stopLossCount = 0;
  let totalTrades = 0;
  let realizedPnl = new Decimal(0);
  let maxDrawdown = new Decimal(0);
  let peakValue = params.investment;
  let stopped = false;

  const firstClose = candles[0].close;

  // Validate that every level meets the exchange minimums at the opening price.
  // Uses real pair constraints when available, falls back to 5 dp precision.
  const baseStep = params.baseStep ?? new Decimal("0.00001");
  const baseDp = baseStep.decimalPlaces() ?? 5;
  const quoteStep = params.quoteStep ?? new Decimal("0.01");
  const quoteDp = quoteStep.decimalPlaces() ?? 2;
  const minOrderSizeQuote = params.minOrderSizeQuote ?? new Decimal(0);
  const previewLevels = buildLevels(firstClose, params, quoteDp);
  for (let i = 0; i < previewLevels.length; i++) {
    const level = previewLevels[i];
    if (minOrderSizeQuote.gt(0) && level.quoteSize.lt(minOrderSizeQuote)) {
      throw new Error(
        `Level #${i} quote size ($${level.quoteSize.toFixed(2)}) is below the exchange ` +
          `minimum order size ($${minOrderSizeQuote.toFixed(2)}). ` +
          `Increase --investment or reduce --max-safety-orders / --scale.`,
      );
    }
    const qty = level.quoteSize
      .div(level.price)
      .toDecimalPlaces(baseDp, Decimal.ROUND_DOWN);
    if (qty.lte(0)) {
      throw new Error(
        `Level #${i} quote size ($${level.quoteSize.toFixed(2)}) produces qty=0 ` +
          `at price $${level.price.toFixed(2)} (base step: ${baseStep.toString()}). ` +
          `Increase --investment or reduce --max-safety-orders / --scale.`,
      );
    }
  }

  let state = initCycle(firstClose, params, quoteDp);

  // Helper: log the market entry trade (called on each new cycle start)
  const applyMarketEntry = (
    st: CycleState,
    entryPrice: Decimal,
    dateStr: string,
    tickFills: string[],
  ): void => {
    const { qty, quoteSize } = applyMarketEntryToState(st, entryPrice, params, baseDp, quoteDp);
    totalTrades++;
    tradeLog.push(
      `${dateStr} BUY  $${entryPrice.toFixed(quoteDp)} qty=${qty.toFixed(baseDp)} [ENTRY] avgEntry=$${st.avgEntryPrice.toFixed(quoteDp)}`,
    );
    trades.push({
      index: totalTrades,
      side: "buy",
      label: "ENTRY",
      price: entryPrice,
      quantity: qty,
      quoteValue: quoteSize,
      realizedPnl,
      roiPct: params.investment.gt(0)
        ? realizedPnl.div(params.investment).times(100)
        : new Decimal(0),
    });
    tickFills.push(
      `BUY [ENTRY] @${entryPrice.toFixed(quoteDp)} qty=${qty.toFixed(baseDp)}`,
    );
  };

  // Apply market entry for the first cycle before the main loop.
  // Use candle[0] date string for the log; tickFills are discarded (no onTick yet).
  {
    const dateStr = candles[0].start
      ? new Date(candles[0].start).toISOString().slice(0, 10)
      : "0";
    applyMarketEntry(state, firstClose, dateStr, []);
  }

  for (let i = 0; i < candles.length; i++) {
    if (stopped) break;
    const candle = candles[i];
    const { high, low, close } = candle;

    // Bearish candle: check sells first then buys; bullish: buys first then sells
    const bearish = close.lt(candle.open);

    const tickFills: string[] = [];

    // Emit the market entry in the tick callback for candle 0 (it was applied before the loop)
    if (i === 0) {
      tickFills.push(
        `BUY [ENTRY] @${firstClose.toFixed(quoteDp)} qty=${state.totalQty.toFixed(baseDp)}`,
      );
    }

    const runBuys = (): void => {
      // Level 0 is always pre-filled (market entry). Only safety orders (1..maxSO) fill here.
      for (const level of state.levels) {
        if (level.filled) continue;
        if (!low.lte(level.price)) continue;

        const qty = level.quoteSize
          .div(level.price)
          .toDecimalPlaces(baseDp, Decimal.ROUND_DOWN);
        level.filled = true;
        state.totalQty = state.totalQty.plus(qty);
        state.totalCost = state.totalCost.plus(level.quoteSize);
        state.avgEntryPrice = state.totalCost.div(state.totalQty);
        state.safetyOrdersFilled++;

        state.tpPrice = state.avgEntryPrice
          .times(new Decimal(1).plus(takeProfit))
          .toDecimalPlaces(quoteDp, Decimal.ROUND_UP);
        totalTrades++;
        const reason = `SO#${state.safetyOrdersFilled}`;
        tradeLog.push(
          `${candle.start ? new Date(candle.start).toISOString().slice(0, 10) : i} BUY  $${level.price.toFixed(quoteDp)} qty=${qty.toFixed(baseDp)} [${reason}] avgEntry=$${state.avgEntryPrice.toFixed(quoteDp)}`,
        );
        trades.push({
          index: totalTrades,
          side: "buy",
          label: reason,
          price: level.price,
          quantity: qty,
          quoteValue: level.quoteSize,
          realizedPnl,
          roiPct: params.investment.gt(0)
            ? realizedPnl.div(params.investment).times(100)
            : new Decimal(0),
        });
        tickFills.push(
          `BUY [${reason}] @${level.price.toFixed(quoteDp)} qty=${qty.toFixed(baseDp)}`,
        );
      }
    };

    const runSells = (): void => {
      if (!state.inPosition) return;

      // Stop-loss check
      if (state.slPrice && low.lte(state.slPrice)) {
        const slFillPrice = state.slPrice;
        const revenue = state.totalQty
          .times(slFillPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(state.totalCost);
        realizedPnl = realizedPnl.plus(profit);
        stopLossCount++;
        completedCycles++;
        totalTrades++;
        tradeLog.push(
          `${candle.start ? new Date(candle.start).toISOString().slice(0, 10) : i} SELL $${slFillPrice.toFixed(quoteDp)} qty=${state.totalQty.toFixed(baseDp)} [STOP-LOSS] pnl=${profit.gte(0) ? "+" : ""}${profit.toFixed(2)}`,
        );
        trades.push({
          index: totalTrades,
          side: "sell",
          label: "STOP-LOSS",
          price: slFillPrice,
          quantity: state.totalQty,
          quoteValue: revenue,
          profit,
          realizedPnl,
          roiPct: params.investment.gt(0)
            ? realizedPnl.div(params.investment).times(100)
            : new Decimal(0),
        });
        tickFills.push(
          `SELL [STOP-LOSS] @${slFillPrice.toFixed(quoteDp)} pnl=${profit.gte(0) ? "+" : ""}${profit.toFixed(2)}`,
        );
        resetCycleState(state);
        stopped = true;
        return;
      }

      // TP check
      if (state.tpPrice && high.gte(state.tpPrice)) {
        const tpFillPrice = state.tpPrice;
        const revenue = state.totalQty
          .times(tpFillPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(state.totalCost);
        realizedPnl = realizedPnl.plus(profit);
        completedCycles++;
        if (profit.gt(0)) winningCycles++;
        totalTrades++;
        tradeLog.push(
          `${candle.start ? new Date(candle.start).toISOString().slice(0, 10) : i} SELL $${tpFillPrice.toFixed(quoteDp)} qty=${state.totalQty.toFixed(baseDp)} [TP] profit=+${profit.toFixed(2)}`,
        );
        trades.push({
          index: totalTrades,
          side: "sell",
          label: "TP",
          price: tpFillPrice,
          quantity: state.totalQty,
          quoteValue: revenue,
          profit,
          realizedPnl,
          roiPct: params.investment.gt(0)
            ? realizedPnl.div(params.investment).times(100)
            : new Decimal(0),
        });
        tickFills.push(
          `SELL [TP] @${tpFillPrice.toFixed(quoteDp)} profit=+${profit.toFixed(2)}`,
        );
        // Start new cycle: market entry at close price
        const dateStr = candle.start
          ? new Date(candle.start).toISOString().slice(0, 10)
          : String(i);
        state = initCycle(close, params, quoteDp);
        applyMarketEntry(state, close, dateStr, tickFills);
      }
    };

    if (bearish) {
      runSells();
      if (!stopped) runBuys();
    } else {
      runBuys();
      runSells();
    }

    // Drawdown tracking
    const unrealized = state.inPosition
      ? state.totalQty.times(close).minus(state.totalCost)
      : new Decimal(0);
    const totalValue = params.investment.plus(realizedPnl).plus(unrealized);
    if (totalValue.gt(peakValue)) peakValue = totalValue;
    const dd = peakValue.minus(totalValue);
    if (dd.gt(maxDrawdown)) maxDrawdown = dd;

    if (onTick) {
      const ts = typeof candle.start === "number" ? candle.start : i * 60000;
      const cash = params.investment.minus(state.totalCost).plus(realizedPnl);
      onTick({
        index: i,
        timestamp: ts,
        open: candle.open,
        high,
        low,
        close,
        realizedPnl,
        unrealizedPnl: unrealized,
        totalValue,
        totalQty: state.totalQty,
        cash,
        inPosition: state.inPosition,
        safetyOrdersFilled: state.safetyOrdersFilled,
        cycle: completedCycles,
        tickFills,
      });
    }
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
    trades,
  };
}

export function optimizeMartingaleParams(
  candles: BacktestCandle[],
  investment: Decimal,
  opts?: {
    priceDeviations?: Decimal[];
    scales?: Decimal[];
    maxSafetyOrdersList?: number[];
    takeProfits?: Decimal[];
    stopLoss?: Decimal;
    maxCombinations?: number;
    days?: number;
    baseStep?: Decimal;
    quoteStep?: Decimal;
    minOrderSizeQuote?: Decimal;
  },
): MartingaleOptimizationResult[] {
  const priceDeviations = opts?.priceDeviations ?? [
    new Decimal("0.01"),
    new Decimal("0.015"),
    new Decimal("0.02"),
    new Decimal("0.025"),
    new Decimal("0.03"),
  ];
  const scales = opts?.scales ?? [
    new Decimal("1.5"),
    new Decimal("2.0"),
    new Decimal("2.5"),
  ];
  const maxSafetyOrdersList = opts?.maxSafetyOrdersList ?? [3, 5, 7];
  const takeProfits = opts?.takeProfits ?? [
    new Decimal("0.01"),
    new Decimal("0.015"),
    new Decimal("0.02"),
    new Decimal("0.025"),
  ];
  const stopLoss = opts?.stopLoss ?? new Decimal("0.15");
  const maxCombinations = opts?.maxCombinations ?? 200;
  const baseStep = opts?.baseStep;
  const quoteStep = opts?.quoteStep;
  const minOrderSizeQuote = opts?.minOrderSizeQuote;

  const combinations: MartingaleBacktestParams[] = [];
  outer: for (const dev of priceDeviations) {
    for (const scale of scales) {
      for (const maxSO of maxSafetyOrdersList) {
        for (const tp of takeProfits) {
          // Validate SL is deep enough: lowest safety order is at entryPrice × (1-dev)^maxSO,
          // so SL must exceed 1 − (1−dev)^maxSO from entry price.
          const minSlRequired = new Decimal(1).minus(
            new Decimal(1).minus(dev).pow(maxSO),
          );
          if (stopLoss.lte(minSlRequired)) continue;

          combinations.push({
            priceDeviation: dev,
            safetyOrderVolumeScale: scale,
            maxSafetyOrders: maxSO,
            takeProfit: tp,
            stopLoss,
            investment,
            baseStep,
            quoteStep,
            minOrderSizeQuote,
          });
          if (combinations.length >= maxCombinations) break outer;
        }
      }
    }
  }

  const days = opts?.days ?? 1;
  const results: MartingaleOptimizationResult[] = [];
  for (const params of combinations) {
    let r: MartingaleBacktestResult;
    try {
      r = runMartingaleBacktest(candles, params);
    } catch {
      // Skip combinations where any level produces qty=0 (investment too small
      // for this price/scale/maxSO combination at 5 decimal places precision).
      continue;
    }
    const annualizedReturn = r.returnPct.div(100).times(365).div(days);
    const maxDrawdownRatio = investment.gt(0)
      ? r.maxDrawdown.div(investment)
      : new Decimal(0);
    const calmar = maxDrawdownRatio.gt(0)
      ? annualizedReturn.div(maxDrawdownRatio)
      : annualizedReturn;
    results.push({
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
      calmarApprox: calmar,
    });
  }

  return results.sort((a, b) => b.totalReturn.minus(a.totalReturn).toNumber());
}
