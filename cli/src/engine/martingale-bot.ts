import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import {
  RevolutXClient,
  InsecureKeyPermissionsError,
} from "@revolut/revolut-x-api";
import type { CurrencyPair, OrderDetails } from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";
import chalk from "chalk";
import type { LivePriceSource } from "../shared/price-source/index.js";
import {
  OrderBookMidProvider,
  withCachedPeek,
} from "../shared/price-source/index.js";
import {
  saveMartingaleState,
  loadMartingaleState,
  deleteMartingaleState,
  type MartingaleState,
  type MartingaleLevelState,
  type MartingaleTradeEntry,
} from "../db/martingale-store.js";
import { loadConnections, type TelegramConnection } from "../db/store.js";
import { sendWithRetries } from "./notify.js";
import { LiveStatusReporter } from "./live-status.js";
import {
  renderMartingaleDashboard,
  renderMartingaleShutdownSummary,
  renderMartingaleReconciliationSummary,
  getCurrSymbol,
  fmtUptime,
  fmtPrice,
  fmtSignedPnl,
  fmtMoney,
  type MartingaleDashboardData,
} from "./martingale-renderer.js";

export interface MartingaleBotConfig {
  pair: string;
  priceDeviation: string;
  safetyOrderVolumeScale: string;
  maxSafetyOrders: number;
  takeProfit: string;
  stopLoss: string;
  investment: string;
  intervalSec: number;
  dryRun: boolean;
  reset: boolean;
}

export interface MartingaleBotTickEvent {
  index: number;
  timestamp: number;
  price: Decimal;
  fills: string[];
  position: Decimal;
  avgEntryPrice: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  tpPrice: Decimal | null;
  slPrice: Decimal | null;
  safetyOrdersFilled: number;
  openOrders: number;
}

export interface MartingaleBotOptions {
  priceSource?: LivePriceSource;
  onTick?: (event: MartingaleBotTickEvent) => void;
  suppressDashboard?: boolean;
}

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const ORDER_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mdV2CodeEscape(text: string): string {
  return text.replace(/([\\`])/g, "\\$1");
}

function fmtLocalDateTime(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function computeBaseOrderPct(scale: Decimal, maxSafetyOrders: number): Decimal {
  const n = maxSafetyOrders + 1;
  if (scale.minus(1).abs().lt(new Decimal("1e-9"))) {
    return new Decimal(1).div(n);
  }
  return scale.minus(1).div(scale.pow(n).minus(1));
}

export class ForegroundMartingaleBot {
  private _config: MartingaleBotConfig;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _client: RevolutXClient | null = null;
  private _state: MartingaleState | null = null;
  private _startTime = 0;
  private _currentPrice: Decimal | null = null;
  private _tickCount = 0;
  private _lastError: string | null = null;
  private _warnings: string[] = [];
  private _pairInfo: CurrencyPair | null = null;
  private _connections: TelegramConnection[] = [];
  private _lastNotifyOk = 0;
  private _cs: string;
  private _priceSource: LivePriceSource | null = null;
  private _onTick: ((event: MartingaleBotTickEvent) => void) | null = null;
  private _tradeLogStart = 0;
  private _suppressDashboard = false;
  private _statusReporter: LiveStatusReporter | null = null;
  private _lifecycle: "running" | "finished" | "stopped" = "running";

  constructor(config: MartingaleBotConfig, options: MartingaleBotOptions = {}) {
    this._config = config;
    this._cs = getCurrSymbol(config.pair);
    this._priceSource = options.priceSource ?? null;
    this._onTick = options.onTick ?? null;
    this._suppressDashboard = options.suppressDashboard === true;
  }

  get connectionCount(): number {
    return this._connections.length;
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  get state(): MartingaleState | null {
    return this._state;
  }

  async run(): Promise<void> {
    this._running = true;
    this._startTime = Date.now();
    this._client = new RevolutXClient({
      generatedBy: "CLI",
      enforceKeyPermissions: true,
    });
    this._connections = loadConnections().filter((c) => c.enabled);

    if (!this._client.isAuthenticated) {
      throw new Error(
        "API credentials not configured. Run 'revx configure' first.",
      );
    }

    if (this._priceSource) {
      this._priceSource = withCachedPeek(this._priceSource);
    } else {
      this._priceSource = new OrderBookMidProvider({
        client: this._client,
        pair: this._config.pair,
        intervalSec: this._config.intervalSec,
      });
    }

    await this._fetchPairInfo();
    const existingState = loadMartingaleState(this._config.pair);

    if (existingState && this._config.reset) {
      console.log(chalk.dim("  --reset flag: discarding saved state..."));
      deleteMartingaleState(this._config.pair);
      await this._initNewCycle();
    } else if (existingState) {
      this._validateResume(existingState);
      await this._reconcileAndInit(existingState);
    } else {
      await this._initNewCycle();
    }

    const cfg = this._state!.config;
    const modeLabel = cfg.dryRun ? " [DRY RUN]" : "";
    this._notify(
      `Martingale Bot started${modeLabel}: ${this._state!.pair} | ` +
        `dev=${new Decimal(cfg.priceDeviation).times(100).toFixed(1)}% ` +
        `scale=${cfg.safetyOrderVolumeScale} ` +
        `SO=${cfg.maxSafetyOrders} ` +
        `TP=${new Decimal(cfg.takeProfit).times(100).toFixed(1)}% ` +
        `SL=${new Decimal(cfg.stopLoss).times(100).toFixed(1)}%`,
    );

    if (this._connections.length > 0) {
      this._statusReporter = new LiveStatusReporter({
        connections: this._connections,
        refs: this._state!.statusMessages,
        minIntervalMs: Math.max(5000, this._config.intervalSec * 1000),
        parseMode: "MarkdownV2",
      });
      await this._statusReporter.flush(this._renderStatusCard());
      this._state!.statusMessages = this._statusReporter.snapshot();
      saveMartingaleState(this._state!);
    }

    await this._loop();
  }

  async shutdown(): Promise<void> {
    if (!this._state || !this._client) return;

    console.log(chalk.dim("\n  Cancelling open orders..."));
    let cancelled = 0;
    let remaining = 0;

    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        try {
          if (!this._config.dryRun) {
            await this._client.cancelOrder(buyOrderId);
          }
          level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
          cancelled++;
        } catch {
          remaining++;
        }
      }
    }

    if (this._state.tpOrderId) {
      try {
        if (!this._config.dryRun) {
          await this._client.cancelOrder(this._state.tpOrderId);
        }
        this._state.tpOrderId = null;
        cancelled++;
      } catch {
        remaining++;
      }
    }

    if (remaining === 0) {
      deleteMartingaleState(this._state.pair);
    } else {
      saveMartingaleState(this._state);
    }

    if (cancelled > 0) {
      console.log(
        chalk.dim(`  Cancelled ${cancelled} order${cancelled !== 1 ? "s" : ""}`),
      );
    }

    let currentPrice: Decimal;
    try {
      currentPrice = await this._getMidPrice();
    } catch {
      currentPrice = this._currentPrice ?? new Decimal(0);
    }

    console.log(renderMartingaleShutdownSummary(this._state, currentPrice, remaining));

    const { realizedPnl, unrealized, totalPnl, netValue } = this._computePnl(currentPrice);
    const cs = this._cs;
    const s = this._state.stats;

    await this._notifyAndWait(
      `Martingale Bot stopped: ${this._state.pair}\n` +
        `${s.completedCycles} cycles (${s.winningCycles} wins)\n` +
        `Realized P&L: ${fmtSignedPnl(realizedPnl, cs)}\n` +
        `Unrealized: ${fmtSignedPnl(unrealized, cs)}\n` +
        `Total P&L: ${fmtSignedPnl(totalPnl, cs)}\n` +
        `Net Value: ${fmtMoney(netValue, cs)}`,
    );

    if (this._lifecycle === "running") this._lifecycle = "finished";
    await this._statusReporter?.flush(this._renderStatusCard());
  }

  // --------------- helpers ---------------

  private async _fetchPairInfo(): Promise<void> {
    try {
      const pairs = await this._client!.getCurrencyPairs();
      const slashPair = this._config.pair.replace("-", "/");
      this._pairInfo = pairs[slashPair] ?? null;
      if (!this._pairInfo) {
        console.log(
          chalk.yellow(
            `\n  Warning: Pair info not found for ${this._config.pair}. Using default precision.`,
          ),
        );
      }
    } catch (err) {
      this._pairInfo = null;
      console.log(
        chalk.yellow(
          `\n  Warning: Failed to fetch pair info: ${err instanceof Error ? err.message : String(err)}.`,
        ),
      );
    }
  }

  private _getQuoteStep(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.quote_step)
      : new Decimal("0.01");
  }

  private _getBaseStep(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.base_step)
      : new Decimal("0.00001");
  }

  private _getMinOrderQuote(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.min_order_size_quote)
      : new Decimal("0");
  }

  private async _getMidPrice(): Promise<Decimal> {
    if (!this._priceSource) throw new Error("price source not initialized");
    if (this._priceSource.peek) return this._priceSource.peek();
    const t = await this._priceSource.next();
    if (!t) throw new Error("price source exhausted");
    return t.price;
  }

  private async _checkBalance(quoteCurrency: string): Promise<Decimal | null> {
    try {
      const balances = await this._client!.getBalances();
      const entry = balances.find((b) => b.currency === quoteCurrency);
      return entry ? new Decimal(entry.available) : new Decimal(0);
    } catch (err) {
      rethrowIfInsecureKey(err);
      console.log(
        chalk.yellow(
          `  Warning: Could not check balance: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return null;
    }
  }

  // --------------- level geometry ---------------

  private _computeSlPrice(currentPrice: Decimal): Decimal {
    const dp = this._getQuoteStep().decimalPlaces();
    return currentPrice
      .times(new Decimal(1).minus(new Decimal(this._config.stopLoss)))
      .toDecimalPlaces(dp, Decimal.ROUND_DOWN);
  }

  private _buildLevels(entryPrice: Decimal): MartingaleLevelState[] {
    const deviation = new Decimal(this._config.priceDeviation);
    const scale = new Decimal(this._config.safetyOrderVolumeScale);
    const basePct = computeBaseOrderPct(scale, this._config.maxSafetyOrders);
    const investment = new Decimal(this._config.investment);
    const quoteStep = this._getQuoteStep();
    const dp = quoteStep.decimalPlaces();

    const levels: MartingaleLevelState[] = [];
    for (let i = 0; i <= this._config.maxSafetyOrders; i++) {
      const price = entryPrice
        .times(new Decimal(1).minus(deviation).pow(i + 1))
        .toDecimalPlaces(dp, Decimal.ROUND_DOWN);
      const quoteSize = investment
        .times(basePct)
        .times(scale.pow(i))
        .toDecimalPlaces(2, Decimal.ROUND_DOWN);
      levels.push({
        index: i,
        price: price.toString(),
        quoteSize: quoteSize.toString(),
        buyOrderIds: [],
        filled: false,
      });
    }
    return levels;
  }

  // --------------- initialization ---------------

  private async _initNewCycle(): Promise<void> {
    const config = this._config;
    console.log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getMidPrice();
    console.log(chalk.dim(`  Current mid-price: ${currentPrice}`));

    const quoteCurrency = config.pair.split("-")[1] ?? "";
    const investment = new Decimal(config.investment);
    const available = config.dryRun
      ? null
      : await this._checkBalance(quoteCurrency);

    if (available !== null && available.lt(investment)) {
      throw new Error(
        `Available ${quoteCurrency} balance (${available.toFixed(2)}) is less than ` +
          `the configured investment (${investment.toFixed(2)}). ` +
          `Deposit funds and retry.`,
      );
    }

    const quoteStep = this._getQuoteStep();
    const baseStep = this._getBaseStep();
    const minQuote = this._getMinOrderQuote();
    const levels = this._buildLevels(currentPrice);

    // Compute SL from current price and validate it's below the lowest level
    const slPrice = this._computeSlPrice(currentPrice);
    const lowestLevel = new Decimal(levels[levels.length - 1].price);
    if (slPrice.gte(lowestLevel)) {
      throw new Error(
        `Computed stop-loss (${slPrice.toFixed(2)}) is not below the lowest safety order level ` +
          `(${lowestLevel.toFixed(2)}). Increase --stop-loss %.`,
      );
    }

    if (minQuote.gt(0)) {
      for (const level of levels) {
        if (new Decimal(level.quoteSize).lt(minQuote)) {
          console.log(
            chalk.yellow(
              `  Warning: Level #${level.index} quote size (${level.quoteSize}) is below min order size (${minQuote}).`,
            ),
          );
        }
      }
    }

    this._state = {
      id: randomUUID().slice(0, 8),
      pair: config.pair,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {
        priceDeviation: config.priceDeviation,
        safetyOrderVolumeScale: config.safetyOrderVolumeScale,
        maxSafetyOrders: config.maxSafetyOrders,
        takeProfit: config.takeProfit,
        stopLoss: config.stopLoss,
        investment: config.investment,
        intervalSec: config.intervalSec,
        dryRun: config.dryRun,
      },
      inPosition: false,
      safetyOrdersFilled: 0,
      totalQty: "0",
      totalCost: "0",
      avgEntryPrice: "0",
      initialBuyPrice: null,
      lastBuyPrice: null,
      tpOrderId: null,
      stopLossPrice: slPrice.toString(),
      quotePrecision: quoteStep.toString(),
      basePrecision: baseStep.toString(),
      levels,
      stats: {
        completedCycles: 0,
        winningCycles: 0,
        realizedPnl: "0",
        totalFees: "0",
        totalBuys: 0,
        totalSells: 0,
      },
      tradeLog: [],
    };

    // Place initial buy order on level[0]
    console.log(chalk.dim("  Placing initial buy order..."));
    try {
      const orderId = await this._placeBuyOrder(levels[0]);
      levels[0].buyOrderIds.push(orderId);
      console.log(chalk.dim(`  Initial buy placed @ ${levels[0].price}`));
    } catch (err) {
      rethrowIfInsecureKey(err);
      throw new Error(
        `Failed to place initial buy order: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    saveMartingaleState(this._state);
    console.log(chalk.dim("  Martingale initialized and state saved.\n"));
  }

  private _validateResume(saved: MartingaleState): void {
    const cfg = this._config;
    const s = saved.config;
    if (s.priceDeviation !== cfg.priceDeviation)
      throw new Error(`Saved state has priceDeviation=${s.priceDeviation} but requested ${cfg.priceDeviation}. Use --reset.`);
    if (s.safetyOrderVolumeScale !== cfg.safetyOrderVolumeScale)
      throw new Error(`Saved state has scale=${s.safetyOrderVolumeScale} but requested ${cfg.safetyOrderVolumeScale}. Use --reset.`);
    if (s.maxSafetyOrders !== cfg.maxSafetyOrders)
      throw new Error(`Saved state has maxSafetyOrders=${s.maxSafetyOrders} but requested ${cfg.maxSafetyOrders}. Use --reset.`);
    if (s.takeProfit !== cfg.takeProfit)
      throw new Error(`Saved state has takeProfit=${s.takeProfit} but requested ${cfg.takeProfit}. Use --reset.`);
    if (s.stopLoss !== cfg.stopLoss)
      throw new Error(`Saved state has stopLoss=${s.stopLoss} but requested ${cfg.stopLoss}. Use --reset.`);
    if (!new Decimal(s.investment).eq(cfg.investment))
      throw new Error(`Saved state has investment=${s.investment} but requested ${cfg.investment}. Use --reset.`);
    if (s.dryRun !== cfg.dryRun)
      throw new Error(`Saved state was started in ${s.dryRun ? "dry-run" : "live"} mode but requested ${cfg.dryRun ? "dry-run" : "live"}. Use --reset.`);
  }

  // --------------- reconciliation ---------------

  private async _reconcileAndInit(savedState: MartingaleState): Promise<void> {
    console.log(chalk.dim("\n  Saved state found. Resuming martingale..."));

    this._state = savedState;
    this._state.config.intervalSec = this._config.intervalSec;
    this._state.quotePrecision = this._getQuoteStep().toString();
    this._state.basePrecision = this._getBaseStep().toString();

    let buysFilled = 0;
    let sellsFilled = 0;
    let ordersKept = 0;
    let ordersDead = 0;

    // Check buy orders on each level
    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (buyOrderId.startsWith("dry-")) { ordersKept++; continue; }
        try {
          const resp = await this._client!.getOrder(buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            buysFilled++;
            level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
            if (!level.filled) {
              level.filled = true;
              const levelPrice = new Decimal(level.price);
              const netBase = this._netBase(order);
              const filledAmount = this._filledAmount(order, levelPrice);
              const feeQuote = this._feeQuote(order, levelPrice);
              this._applyBuyFill(level, netBase, filledAmount, feeQuote, order.id);
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
            ordersDead++;
          } else {
            ordersKept++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
          ordersDead++;
        }
        await sleep(ORDER_DELAY_MS);
      }
    }

    // Check TP sell order
    if (this._state.tpOrderId && !this._state.tpOrderId.startsWith("dry-")) {
      try {
        const resp = await this._client!.getOrder(this._state.tpOrderId);
        const order = resp.data;
        if (FILLED_STATUSES.has(order.status)) {
          sellsFilled++;
          const totalQty = new Decimal(this._state.totalQty);
          const tpPrice = this._state.avgEntryPrice
            ? new Decimal(this._state.avgEntryPrice).times(
                new Decimal(1).plus(this._config.takeProfit),
              )
            : new Decimal(order.filled_amount || 0).div(totalQty.gt(0) ? totalQty : 1);
          const filledAmount = this._filledAmount(order, tpPrice);
          const feeQuote = this._feeQuote(order, tpPrice);
          this._applyTpFill(filledAmount, feeQuote, order.id, tpPrice);
        } else if (DEAD_STATUSES.has(order.status)) {
          this._state.tpOrderId = null;
          ordersDead++;
        } else {
          ordersKept++;
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._state.tpOrderId = null;
        ordersDead++;
      }
      await sleep(ORDER_DELAY_MS);
    } else if (this._state.tpOrderId?.startsWith("dry-")) {
      ordersKept++;
    }

    saveMartingaleState(this._state);
    console.log(renderMartingaleReconciliationSummary(buysFilled, sellsFilled, ordersKept, ordersDead));
    console.log(chalk.dim("  Martingale resumed and state saved.\n"));

    if (buysFilled + sellsFilled > 0) {
      const parts = [`Martingale reconciled: ${this._config.pair}`];
      if (buysFilled > 0) parts.push(`${buysFilled} buy${buysFilled !== 1 ? "s" : ""} filled offline`);
      if (sellsFilled > 0) parts.push(`${sellsFilled} sell${sellsFilled !== 1 ? "s" : ""} filled offline`);
      this._notify(parts.join(" | "));
    }
  }

  // --------------- fill accounting ---------------

  private _applyBuyFill(
    level: MartingaleLevelState,
    netBase: Decimal,
    filledAmount: Decimal,
    feeQuote: Decimal,
    orderId: string,
  ): void {
    const state = this._state!;
    const isInitial = !state.inPosition;

    state.totalQty = new Decimal(state.totalQty).plus(netBase).toString();
    state.totalCost = new Decimal(state.totalCost).plus(filledAmount).plus(feeQuote).toString();
    state.avgEntryPrice = new Decimal(state.totalCost).div(new Decimal(state.totalQty)).toString();
    state.lastBuyPrice = level.price;
    this._addFee(feeQuote);

    if (isInitial) {
      state.inPosition = true;
      state.initialBuyPrice = level.price;
    } else {
      state.safetyOrdersFilled++;
    }

    state.stats.totalBuys++;
    const reason: MartingaleTradeEntry["reason"] = isInitial ? "initial" : "safety";
    this._logTrade("buy", level.price, netBase.toString(), orderId, reason, undefined, feeQuote.gt(0) ? feeQuote.toString() : undefined);
  }

  private _applyTpFill(filledAmount: Decimal, feeQuote: Decimal, orderId: string, sellPrice: Decimal): void {
    const state = this._state!;
    const totalQty = new Decimal(state.totalQty);
    const totalCost = new Decimal(state.totalCost);
    const revenue = filledAmount.minus(feeQuote);
    const profit = revenue.minus(totalCost);

    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl).plus(profit).toString();
    state.stats.completedCycles++;
    state.stats.totalSells++;
    if (profit.gt(0)) state.stats.winningCycles++;
    this._addFee(feeQuote);
    this._logTrade("sell", sellPrice.toString(), totalQty.toString(), orderId, "tp", profit.toFixed(2), feeQuote.gt(0) ? feeQuote.toString() : undefined);
    this._resetCycle();
  }

  private _resetCycle(): void {
    const state = this._state!;
    state.inPosition = false;
    state.safetyOrdersFilled = 0;
    state.totalQty = "0";
    state.totalCost = "0";
    state.avgEntryPrice = "0";
    state.initialBuyPrice = null;
    state.lastBuyPrice = null;
    state.tpOrderId = null;
    state.stopLossPrice = null;
    for (const level of state.levels) {
      level.buyOrderIds = [];
      level.filled = false;
    }
  }

  // --------------- stop loss ---------------

  private async _triggerStopLoss(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client;
    const cs = this._cs;

    // Cancel all open orders
    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        for (const id of level.buyOrderIds) {
          cancels.push(client.cancelOrder(id).catch((err) => rethrowIfInsecureKey(err)));
        }
      }
      if (state.tpOrderId) {
        cancels.push(client.cancelOrder(state.tpOrderId).catch((err) => rethrowIfInsecureKey(err)));
      }
      await Promise.all(cancels);
    }

    for (const level of state.levels) level.buyOrderIds = [];
    state.tpOrderId = null;

    const baseStep = this._getBaseStep();
    const totalQty = new Decimal(state.totalQty)
      .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

    if (totalQty.gt(0)) {
      if (!this._config.dryRun && client) {
        try {
          const resp = await client.placeOrder({
            symbol: this._config.pair,
            side: "sell",
            market: { baseSize: totalQty.toString() },
          });
          const filled = await this._awaitOrderFill(resp.data.venue_order_id);
          const feeQuote = this._feeQuote(filled, currentPrice);
          const filledAmount = this._filledAmount(filled, currentPrice);
          const revenue = filledAmount.minus(feeQuote);
          const profit = revenue.minus(new Decimal(state.totalCost));
          state.stats.realizedPnl = new Decimal(state.stats.realizedPnl).plus(profit).toString();
          state.stats.totalSells++;
          state.stats.completedCycles++;
          this._addFee(feeQuote);
          this._logTrade("sell", currentPrice.toString(), totalQty.toString(), filled.id, "sl", profit.toFixed(2), feeQuote.gt(0) ? feeQuote.toString() : undefined);
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(`Stop-loss market sell failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (this._config.dryRun) {
        const revenue = totalQty.times(currentPrice).toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(new Decimal(state.totalCost));
        state.stats.realizedPnl = new Decimal(state.stats.realizedPnl).plus(profit).toString();
        state.stats.totalSells++;
        state.stats.completedCycles++;
        this._logTrade("sell", currentPrice.toString(), totalQty.toString(), "dry-sl", "sl", profit.toFixed(2));
      }
    }

    this._notify(
      `Martingale Bot ${state.pair}: STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)}. ` +
        `Sold ${totalQty} base. Realized P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}`,
    );

    this._resetCycle();
    this._lifecycle = "stopped";
    this._currentPrice = currentPrice;
    if (this._statusReporter) {
      await this._statusReporter.flush(this._renderStatusCard());
      state.statusMessages = this._statusReporter.snapshot();
    }
    saveMartingaleState(state);
    this.stop();
  }

  // --------------- main loop ---------------

  private async _loop(): Promise<void> {
    const source = this._priceSource!;
    while (this._running) {
      const cycleStart = performance.now();

      let tick;
      try {
        tick = await source.next();
      } catch (err) {
        if (err instanceof InsecureKeyPermissionsError) {
          console.log(chalk.red(`\n  Halting: credential file permissions are unsafe.\n  ${err.message}`));
          this.stop();
          throw err;
        }
        this._lastError = err instanceof Error ? err.message : String(err);
        this._render();
        if (!this._running) break;
        await this._paceSleep(cycleStart, source.paceIntervalSec);
        continue;
      }

      if (!tick) {
        console.log(chalk.dim("\n  Price source exhausted; stopping loop."));
        this.stop();
        break;
      }

      this._tradeLogStart = this._state?.tradeLog.length ?? 0;

      try {
        await this._tick(tick.price);
        this._lastError = null;
      } catch (err) {
        if (err instanceof InsecureKeyPermissionsError) {
          console.log(chalk.red(`\n  Halting: credential file permissions are unsafe.\n  ${err.message}`));
          this.stop();
          throw err;
        }
        this._lastError = err instanceof Error ? err.message : String(err);
      }

      this._render();
      this._emitTickEvent(tick.price, tick.timestamp);
      this._statusReporter?.update(this._renderStatusCard());

      if (!this._running) break;
      await this._paceSleep(cycleStart, source.paceIntervalSec);
    }
    await this._priceSource?.close?.();
  }

  private async _paceSleep(cycleStart: number, paceIntervalSec: number | undefined): Promise<void> {
    if (paceIntervalSec === undefined) return;
    const elapsed = (performance.now() - cycleStart) / 1000;
    const delay = Math.max(0, paceIntervalSec - elapsed) * 1000;
    if (delay <= 0) return;
    await new Promise<void>((resolve) => {
      this._timer = setTimeout(() => { this._timer = null; resolve(); }, delay);
    });
  }

  // --------------- tick ---------------

  private async _tick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client!;
    this._warnings = [];
    this._connections = loadConnections().filter((c) => c.enabled);
    this._currentPrice = currentPrice;

    // 1. Stop-loss check
    if (state.stopLossPrice && state.inPosition) {
      if (currentPrice.lte(new Decimal(state.stopLossPrice))) {
        await this._triggerStopLoss(currentPrice);
        return;
      }
    }

    if (this._config.dryRun) {
      await this._dryRunTick(currentPrice);
      this._tickCount++;
      return;
    }

    // 2. Fetch active order IDs
    const activeOrderIds = new Set<string>();
    try {
      let cursor: string | undefined;
      do {
        const resp = await client.getActiveOrders({
          symbols: [this._config.pair],
          cursor,
          limit: 100,
        });
        for (const o of resp.data) activeOrderIds.add(o.id);
        cursor = resp.metadata?.next_cursor as string | undefined;
      } while (cursor);
    } catch (err) {
      throw new Error(`Failed to fetch active orders: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Check buy order fills
    for (const level of state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (activeOrderIds.has(buyOrderId)) continue;
        try {
          const resp = await client.getOrder(buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
            level.filled = true;

            const levelPrice = new Decimal(level.price);
            const netBase = this._netBase(order);
            const filledAmount = this._filledAmount(order, levelPrice);
            const feeQuote = this._feeQuote(order, levelPrice);
            this._applyBuyFill(level, netBase, filledAmount, feeQuote, order.id);

            const base = this._config.pair.split("-")[0] ?? "";
            const cs = this._cs;
            const feeStr = feeQuote.gt(0) ? ` | fee ${cs}${feeQuote.toFixed(2)}` : "";
            this._notify(
              `Martingale ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${netBase} ${base} | ` +
                `avg entry ${cs}${new Decimal(state.avgEntryPrice).toFixed(2)}${feeStr}`,
            );

            // Move TP order
            if (state.tpOrderId) {
              try { await client.cancelOrder(state.tpOrderId); } catch { /* ignore */ }
              state.tpOrderId = null;
            }
            await this._placeTpOrder();

            // Arm next safety order level
            const nextLevel = state.levels[level.index + 1];
            if (nextLevel && !nextLevel.filled && nextLevel.buyOrderIds.length === 0) {
              try {
                const orderId = await this._placeBuyOrder(nextLevel);
                nextLevel.buyOrderIds.push(orderId);
              } catch (err) {
                rethrowIfInsecureKey(err);
                this._warnings.push(`Safety order #${nextLevel.index + 1}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
            // Re-place if level not yet filled
            if (!level.filled) {
              try {
                const orderId = await this._placeBuyOrder(level);
                level.buyOrderIds.push(orderId);
              } catch (err) {
                rethrowIfInsecureKey(err);
                this._warnings.push(`Re-buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(`Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 4. Check TP sell order
    if (state.tpOrderId && !activeOrderIds.has(state.tpOrderId)) {
      try {
        const resp = await client.getOrder(state.tpOrderId);
        const order = resp.data;
        if (FILLED_STATUSES.has(order.status)) {
          const tpPrice = new Decimal(state.avgEntryPrice).times(
            new Decimal(1).plus(new Decimal(this._config.takeProfit)),
          );
          const filledAmount = this._filledAmount(order, tpPrice);
          const feeQuote = this._feeQuote(order, tpPrice);
          const profit = filledAmount.minus(feeQuote).minus(new Decimal(state.totalCost));

          const cs = this._cs;
          const feeStr = feeQuote.gt(0) ? ` | fee ${cs}${feeQuote.toFixed(2)}` : "";
          this._notify(
            `Martingale ${this._config.pair}: TAKE PROFIT @ ${cs}${tpPrice.toFixed(2)} | ` +
              `profit ${cs}${profit.toFixed(2)} | ` +
              `total P&L: ${cs}${new Decimal(state.stats.realizedPnl).plus(profit).toFixed(2)}${feeStr}`,
          );

          state.tpOrderId = null;
          this._applyTpFill(filledAmount, feeQuote, order.id, tpPrice);

          // Rebuild levels for new cycle and place initial buy
          const newLevels = this._buildLevels(currentPrice);
          state.levels = newLevels;
          state.stopLossPrice = this._computeSlPrice(currentPrice).toString();
          try {
            const orderId = await this._placeBuyOrder(newLevels[0]);
            newLevels[0].buyOrderIds.push(orderId);
          } catch (err) {
            rethrowIfInsecureKey(err);
            this._warnings.push(`New cycle initial buy: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (DEAD_STATUSES.has(order.status)) {
          state.tpOrderId = null;
          // Re-place TP
          await this._placeTpOrder();
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._warnings.push(`Check TP: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 5. Orphan recovery: if no position and no buy order on level[0]
    if (!state.inPosition && state.levels[0].buyOrderIds.length === 0) {
      try {
        const orderId = await this._placeBuyOrder(state.levels[0]);
        state.levels[0].buyOrderIds.push(orderId);
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._warnings.push(`Orphan recovery buy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6. TP recovery: in position but no TP order
    if (state.inPosition && !state.tpOrderId) {
      await this._placeTpOrder();
    }

    this._saveRunningState();
    this._tickCount++;
  }

  // --------------- dry run ---------------

  private async _dryRunTick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;

    // Simulate buy fills
    for (const level of state.levels) {
      if (level.filled || level.buyOrderIds.length === 0) continue;
      if (!currentPrice.lte(new Decimal(level.price))) continue;

      const levelPrice = new Decimal(level.price);
      const quoteSize = new Decimal(level.quoteSize);
      const baseStep = this._getBaseStep();
      const filledQty = quoteSize
        .div(levelPrice)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

      level.buyOrderIds = [];
      level.filled = true;
      this._applyBuyFill(level, filledQty, quoteSize, new Decimal(0), `dry-buy-${randomUUID().slice(0, 8)}`);

      const base = this._config.pair.split("-")[0] ?? "";
      const cs = this._cs;
      this._notify(
        `Martingale ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${filledQty} ${base} [DRY RUN]`,
      );

      // Arm next safety order
      const nextLevel = state.levels[level.index + 1];
      if (nextLevel && !nextLevel.filled && nextLevel.buyOrderIds.length === 0) {
        nextLevel.buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
      }

      state.tpOrderId = `dry-sell-tp-${randomUUID().slice(0, 8)}`;
    }

    // After buy fills: re-check stop-loss (price may have dropped below SL in same tick as entry)
    if (state.inPosition && state.stopLossPrice && currentPrice.lte(new Decimal(state.stopLossPrice))) {
      await this._triggerStopLoss(currentPrice);
      return;
    }

    // Simulate TP fill
    if (state.tpOrderId && state.inPosition) {
      const tpPrice = new Decimal(state.avgEntryPrice).times(
        new Decimal(1).plus(new Decimal(this._config.takeProfit)),
      );
      if (currentPrice.gte(tpPrice)) {
        const totalQty = new Decimal(state.totalQty);
        const revenue = totalQty.times(tpPrice).toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(new Decimal(state.totalCost));

        const cs = this._cs;
        this._notify(
          `Martingale ${this._config.pair}: TAKE PROFIT @ ${cs}${tpPrice.toFixed(2)} | ` +
            `profit ${cs}${profit.toFixed(2)} [DRY RUN]`,
        );

        state.tpOrderId = null;
        this._applyTpFill(revenue, new Decimal(0), `dry-sell-${randomUUID().slice(0, 8)}`, tpPrice);

        // Rebuild for new cycle
        const newLevels = this._buildLevels(currentPrice);
        state.levels = newLevels;
        state.stopLossPrice = this._computeSlPrice(currentPrice).toString();
        newLevels[0].buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
      }
    }

    // Orphan recovery
    if (!state.inPosition && state.levels[0].buyOrderIds.length === 0) {
      state.levels[0].buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
    }

    this._saveRunningState();
  }

  // --------------- order placement ---------------

  private async _placeBuyOrder(level: MartingaleLevelState): Promise<string> {
    if (this._config.dryRun) return `dry-buy-${randomUUID().slice(0, 8)}`;
    const resp = await this._client!.placeOrder({
      symbol: this._config.pair,
      side: "buy",
      limit: {
        price: level.price,
        quoteSize: level.quoteSize,
        executionInstructions: ["post_only"],
      },
    });
    return resp.data.venue_order_id;
  }

  private async _placeTpOrder(): Promise<void> {
    const state = this._state!;
    if (!state.inPosition || new Decimal(state.totalQty).lte(0)) return;

    const tpPrice = new Decimal(state.avgEntryPrice)
      .times(new Decimal(1).plus(new Decimal(this._config.takeProfit)))
      .toDecimalPlaces(this._getQuoteStep().decimalPlaces(), Decimal.ROUND_UP);

    const totalQty = new Decimal(state.totalQty)
      .toDecimalPlaces(this._getBaseStep().decimalPlaces(), Decimal.ROUND_DOWN);

    if (this._config.dryRun) {
      state.tpOrderId = `dry-sell-tp-${randomUUID().slice(0, 8)}`;
      return;
    }

    try {
      const resp = await this._client!.placeOrder({
        symbol: this._config.pair,
        side: "sell",
        limit: {
          price: tpPrice.toString(),
          baseSize: totalQty.toString(),
          executionInstructions: ["post_only"],
        },
      });
      state.tpOrderId = resp.data.venue_order_id;
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._warnings.push(`TP order @${tpPrice}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --------------- awaiting fills ---------------

  private async _awaitOrderFill(orderId: string, timeoutMs = 30_000): Promise<OrderDetails> {
    const client = this._client!;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await client.getOrder(orderId);
        const order = resp.data;
        if (FILLED_STATUSES.has(order.status)) return order;
        if (DEAD_STATUSES.has(order.status)) throw new Error(`Order ${order.status}: ${orderId}`);
      } catch (err) {
        if (err instanceof Error && !err.message.startsWith("Order ")) throw err;
      }
      await sleep(500);
    }
    throw new Error(`Order did not fill within ${timeoutMs / 1000}s: ${orderId}`);
  }

  // --------------- fees ---------------

  private _feeQuote(order: OrderDetails, fallbackPrice: Decimal): Decimal {
    const fee = order.total_fee ? new Decimal(order.total_fee) : new Decimal(0);
    if (fee.isZero()) return new Decimal(0);
    const baseCurrency = this._config.pair.split("-")[0] ?? "";
    const quoteCurrency = this._config.pair.split("-")[1] ?? "";
    if (order.fee_currency === quoteCurrency) return fee;
    if (order.fee_currency === baseCurrency) {
      const filledQty = new Decimal(order.filled_quantity);
      const filledAmount = order.filled_amount
        ? new Decimal(order.filled_amount)
        : filledQty.times(fallbackPrice);
      const price = filledQty.gt(0) ? filledAmount.div(filledQty) : fallbackPrice;
      return fee.times(price);
    }
    return new Decimal(0);
  }

  private _netBase(order: OrderDetails): Decimal {
    const filledQty = new Decimal(order.filled_quantity);
    const fee = order.total_fee ? new Decimal(order.total_fee) : new Decimal(0);
    const baseCurrency = this._config.pair.split("-")[0] ?? "";
    if (order.fee_currency === baseCurrency && fee.gt(0)) {
      return Decimal.max(new Decimal(0), filledQty.minus(fee));
    }
    return filledQty;
  }

  private _filledAmount(order: OrderDetails, fallbackPrice: Decimal): Decimal {
    if (order.filled_amount) return new Decimal(order.filled_amount);
    return new Decimal(order.filled_quantity).times(fallbackPrice);
  }

  private _addFee(fee: Decimal): void {
    if (!this._state || fee.lte(0)) return;
    const cur = new Decimal(this._state.stats.totalFees ?? "0");
    this._state.stats.totalFees = cur.plus(fee).toString();
  }

  // --------------- P&L ---------------

  private _computePnl(currentPrice: Decimal): {
    position: Decimal;
    realizedPnl: Decimal;
    unrealized: Decimal;
    totalPnl: Decimal;
    netValue: Decimal;
    openOrders: number;
  } {
    const state = this._state!;
    const position = new Decimal(state.totalQty);
    const costBasis = new Decimal(state.totalCost);
    const realizedPnl = new Decimal(state.stats.realizedPnl ?? "0");
    const unrealized = position.gt(0) ? position.times(currentPrice).minus(costBasis) : new Decimal(0);
    const totalPnl = realizedPnl.plus(unrealized);
    const netValue = new Decimal(state.config.investment).plus(totalPnl);

    let openOrders = 0;
    for (const level of state.levels) openOrders += level.buyOrderIds.length;
    if (state.tpOrderId) openOrders++;

    return { position, realizedPnl, unrealized, totalPnl, netValue, openOrders };
  }

  // --------------- state & rendering ---------------

  private _saveRunningState(): void {
    const state = this._state!;
    if (this._statusReporter) state.statusMessages = this._statusReporter.snapshot();
    saveMartingaleState(state);
  }

  private _emitTickEvent(price: Decimal, timestamp: number): void {
    if (!this._onTick || !this._state) return;
    const fills: string[] = [];
    const newEntries = this._state.tradeLog.slice(this._tradeLogStart);
    for (const e of newEntries) {
      fills.push(`${e.side.toUpperCase()} ${e.quantity}@${e.price} [${e.reason}]`);
    }
    const { position, realizedPnl, unrealized, openOrders } = this._computePnl(price);
    const state = this._state;
    this._onTick({
      index: this._tickCount,
      timestamp,
      price,
      fills,
      position,
      avgEntryPrice: state.inPosition ? new Decimal(state.avgEntryPrice) : new Decimal(0),
      realizedPnl,
      unrealizedPnl: unrealized,
      tpPrice: state.tpOrderId && state.avgEntryPrice !== "0"
        ? new Decimal(state.avgEntryPrice).times(new Decimal(1).plus(new Decimal(this._config.takeProfit)))
        : null,
      slPrice: state.stopLossPrice ? new Decimal(state.stopLossPrice) : null,
      safetyOrdersFilled: state.safetyOrdersFilled,
      openOrders,
    });
  }

  private _renderStatusCard(): string {
    const state = this._state!;
    const cs = this._cs;
    const price = this._currentPrice ?? new Decimal(0);
    const { position, realizedPnl, unrealized, totalPnl, netValue } = this._computePnl(price);
    const investment = new Decimal(state.config.investment);
    const totalPct = investment.gt(0) ? totalPnl.div(investment).times(100) : new Decimal(0);

    let glyph: string;
    let label: string;
    if (this._lifecycle === "finished") {
      glyph = "✅"; label = "Finished";
    } else if (this._lifecycle === "stopped") {
      glyph = "\u{1f534}"; label = "Stopped (stop-loss)";
    } else {
      glyph = "\u{1f7e2}";
      const dir = totalPnl.gt(0) ? "▲" : totalPnl.lt(0) ? "▼" : "━";
      label = `Running ${dir} ${totalPct.gte(0) ? "+" : ""}${totalPct.toFixed(2)}%`;
    }

    const mode = state.config.dryRun ? " [DRY RUN]" : "";
    const base = state.pair.split("-")[0] ?? "";
    const s = state.stats;
    const tpPrice = state.inPosition && state.avgEntryPrice !== "0"
      ? new Decimal(state.avgEntryPrice).times(new Decimal(1).plus(new Decimal(state.config.takeProfit)))
      : null;

    const soBar = Array.from({ length: state.config.maxSafetyOrders + 1 }, (_, i) =>
      i < state.safetyOrdersFilled + (state.inPosition ? 1 : 0) ? "■" : "□",
    ).join("");

    const body = [
      `${glyph} Martingale ${state.pair}${mode}  ${label}`,
      `Price ${fmtPrice(price, cs)} · Pos ${position.toFixed()} ${base}`,
      state.inPosition ? `Avg Entry ${fmtPrice(new Decimal(state.avgEntryPrice), cs)} · SO [${soBar}]` : `Waiting for entry · SO [${soBar}]`,
      tpPrice ? `TP ${fmtPrice(tpPrice, cs)} · SL ${state.stopLossPrice ? fmtPrice(new Decimal(state.stopLossPrice), cs) : "—"}` : "",
      `Realized ${fmtSignedPnl(realizedPnl, cs)} · Unreal ${fmtSignedPnl(unrealized, cs)}`,
      `Total ${fmtSignedPnl(totalPnl, cs)} · Net ${fmtMoney(netValue, cs)}`,
      `Cycles ${s.completedCycles} (${s.winningCycles} wins) · Up ${fmtUptime(Date.now() - this._startTime)}`,
      "",
      `Updated ${fmtLocalDateTime()}`,
    ].filter(Boolean).join("\n");

    return "```\n" + mdV2CodeEscape(body) + "\n```";
  }

  private _render(): void {
    if (!this._state || this._suppressDashboard) return;
    const currentPrice = this._currentPrice ?? new Decimal(0);
    const data: MartingaleDashboardData = {
      state: this._state,
      currentPrice,
      uptime: Date.now() - this._startTime,
      tickCount: this._tickCount,
      lastError: this._lastError,
      warnings: this._warnings,
      telegramConnections: this._connections.length,
      intervalSec: this._config.intervalSec,
      lastNotifyOk: this._lastNotifyOk,
      lifecycle: this._lifecycle,
    };
    process.stdout.write("\x1B[2J\x1B[H");
    console.log(renderMartingaleDashboard(data));
  }

  // --------------- notifications ---------------

  private _notify(message: string): void {
    if (this._connections.length === 0) return;
    for (const tc of this._connections) {
      void sendWithRetries(tc.bot_token, tc.chat_id, message).then((r) => {
        if (r.success) this._lastNotifyOk = Date.now();
      });
    }
  }

  private async _notifyAndWait(message: string): Promise<void> {
    if (this._connections.length === 0) return;
    const results = await Promise.allSettled(
      this._connections.map((tc) => sendWithRetries(tc.bot_token, tc.chat_id, message)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.success) this._lastNotifyOk = Date.now();
    }
  }

  private _logTrade(
    side: "buy" | "sell",
    price: string,
    quantity: string,
    orderId: string,
    reason: MartingaleTradeEntry["reason"],
    profit?: string,
    fee?: string,
  ): void {
    const entry: MartingaleTradeEntry = { ts: new Date().toISOString(), side, price, quantity, orderId, reason };
    if (profit !== undefined) entry.profit = profit;
    if (fee !== undefined) entry.fee = fee;
    this._state!.tradeLog.push(entry);
  }
}
