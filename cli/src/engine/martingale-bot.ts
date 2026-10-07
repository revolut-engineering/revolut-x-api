import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import {
  RevolutXClient,
  InsecureKeyPermissionsError,
  NotFoundError,
} from "@revolut/revolut-x-api";
import type { CurrencyPair, OrderDetails } from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";
import chalk from "chalk";
import type { LivePriceSource } from "../shared/price-source/index.js";
import {
  TickerPriceProvider,
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
import { TAKER_FEE_RATE } from "./grid-math.js";
import {
  averageFillPrice,
  buyEconomics,
  filledAmount,
  sellEconomics,
  type BuyEconomics,
  type SellEconomics,
} from "./fee-math.js";
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

interface SafetyOrderBooking {
  baseReceived: Decimal;
  feeQuote: Decimal;
  remainingQuote: Decimal;
}

interface SaleBooking {
  soldBase: Decimal;
  profit: Decimal;
  feeQuote: Decimal;
  price: Decimal;
}

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const PARTIALLY_FILLED_STATUS = "partially_filled";
const ORDER_DELAY_MS = 200;
const STOP_LOSS_SELL_ATTEMPTS = 3;
const STOP_LOSS_RETRY_DELAY_MS = 2000;

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

export function computeBaseOrderPct(
  scale: Decimal,
  maxSafetyOrders: number,
): Decimal {
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
  /** Counts consecutive TP placement failures; resets to 0 on any successful placement. */
  private _tpFailureCount = 0;

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
      this._priceSource = new TickerPriceProvider({
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
    if (!this._running) return;

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
          level.buyOrderIds = level.buyOrderIds.filter(
            (id) => id !== buyOrderId,
          );
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
        chalk.dim(
          `  Cancelled ${cancelled} order${cancelled !== 1 ? "s" : ""}`,
        ),
      );
    }

    let currentPrice: Decimal;
    try {
      currentPrice = await this._getCurrentPrice();
    } catch {
      currentPrice = this._currentPrice ?? new Decimal(0);
    }

    console.log(
      renderMartingaleShutdownSummary(this._state, currentPrice, remaining),
    );

    const { realizedPnl, unrealized, totalPnl, netValue } =
      this._computePnl(currentPrice);
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

  private _getMinOrderBase(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.min_order_size)
      : new Decimal("0");
  }

  private _getMinOrderQuote(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.min_order_size_quote)
      : new Decimal("0");
  }

  private async _getCurrentPrice(): Promise<Decimal> {
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

  private async _cancelAllOpenOrders(): Promise<void> {
    if (!this._client || this._config.dryRun || !this._state) return;
    const state = this._state;
    const cancels: Promise<void>[] = [];
    for (const level of state.levels) {
      for (const id of [...level.buyOrderIds]) {
        cancels.push(
          this._client
            .cancelOrder(id)
            .catch((err) => rethrowIfInsecureKey(err)),
        );
      }
    }
    if (state.tpOrderId) {
      cancels.push(
        this._client
          .cancelOrder(state.tpOrderId)
          .catch((err) => rethrowIfInsecureKey(err)),
      );
    }
    await Promise.all(cancels);
    for (const level of state.levels) level.buyOrderIds = [];
    state.tpOrderId = null;
  }

  private async _handleCannotPlaceOrder(
    type: string,
    reason: string,
  ): Promise<void> {
    const pair = this._config.pair;
    const msg =
      `Can't place ${type} order: ${reason}. ` +
      `Bot stopped — check the exchange and restart with --reset once resolved.`;
    this._warnings.push(msg);
    console.log(chalk.red(`\n  ✗ ${msg}`));
    await this._cancelAllOpenOrders();
    await this._notifyAndWait(
      `🚨 Martingale ${pair}: Can't place ${type} order.\n` +
        `Reason: ${reason}\n` +
        `Bot stopped — check the exchange and restart with \`--reset\` once resolved.`,
    );
    this._lifecycle = "stopped";
    this._saveRunningState();
    this.stop();
  }

  private async _handleOrderFailureLimit(
    type: "TP",
    detail: string,
  ): Promise<void> {
    const pair = this._config.pair;
    const cs = this._cs;

    const msg =
      `${type} order failed 3 times in a row` +
      (detail ? ` (${cs}${detail})` : "") +
      `. Bot stopped — no new cycle will be started. ` +
      `Check the exchange and restart with --reset once resolved.`;

    this._warnings.push(msg);
    console.log(chalk.red(`\n  ✗ ${msg}`));

    await this._cancelAllOpenOrders();
    await this._notifyAndWait(
      `🚨 Martingale ${pair}: ${type} order failed 3 times in a row` +
        (detail ? ` @ ${cs}${detail}` : "") +
        `.\nBot stopped — no new cycle started.\n` +
        `Check the exchange and restart with \`--reset\` once resolved.`,
    );

    this._lifecycle = "stopped";
    this._saveRunningState();
    this.stop();
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
      const price =
        i === 0
          ? entryPrice.toDecimalPlaces(dp, Decimal.ROUND_DOWN)
          : entryPrice
              .times(new Decimal(1).minus(deviation).pow(i))
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
    const currentPrice = await this._getCurrentPrice();
    console.log(chalk.dim(`  Current price: ${currentPrice}`));

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

    console.log(chalk.dim("  Placing market entry order..."));
    let entered: boolean;
    try {
      entered = await this._placeMarketEntry(currentPrice);
    } catch (err) {
      rethrowIfInsecureKey(err);
      throw new Error(
        `Failed to place market entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!entered) return;
    console.log(
      chalk.dim(
        `  Market entry filled @ ${this._cs}${this._state.initialBuyPrice}`,
      ),
    );

    await this._placeTpOrder();

    console.log(
      chalk.dim(
        `  Placing ${this._state.levels.length - 1} safety order(s)...`,
      ),
    );
    if (!(await this._placeAllSafetyOrders(this._state.levels))) return;

    saveMartingaleState(this._state);
    console.log(chalk.dim("  Martingale initialized and state saved.\n"));
  }

  private _validateResume(saved: MartingaleState): void {
    const cfg = this._config;
    const s = saved.config;
    if (s.priceDeviation !== cfg.priceDeviation)
      throw new Error(
        `Saved state has priceDeviation=${s.priceDeviation} but requested ${cfg.priceDeviation}. Use --reset.`,
      );
    if (s.safetyOrderVolumeScale !== cfg.safetyOrderVolumeScale)
      throw new Error(
        `Saved state has scale=${s.safetyOrderVolumeScale} but requested ${cfg.safetyOrderVolumeScale}. Use --reset.`,
      );
    if (s.maxSafetyOrders !== cfg.maxSafetyOrders)
      throw new Error(
        `Saved state has maxSafetyOrders=${s.maxSafetyOrders} but requested ${cfg.maxSafetyOrders}. Use --reset.`,
      );
    if (s.takeProfit !== cfg.takeProfit)
      throw new Error(
        `Saved state has takeProfit=${s.takeProfit} but requested ${cfg.takeProfit}. Use --reset.`,
      );
    if (s.stopLoss !== cfg.stopLoss)
      throw new Error(
        `Saved state has stopLoss=${s.stopLoss} but requested ${cfg.stopLoss}. Use --reset.`,
      );
    if (!new Decimal(s.investment).eq(cfg.investment))
      throw new Error(
        `Saved state has investment=${s.investment} but requested ${cfg.investment}. Use --reset.`,
      );
    if (s.dryRun !== cfg.dryRun)
      throw new Error(
        `Saved state was started in ${s.dryRun ? "dry-run" : "live"} mode but requested ${cfg.dryRun ? "dry-run" : "live"}. Use --reset.`,
      );
  }

  // --------------- reconciliation ---------------

  private async _reconcileAndInit(savedState: MartingaleState): Promise<void> {
    console.log(chalk.dim("\n  Saved state found. Resuming martingale..."));

    this._state = savedState;
    this._state.config.intervalSec = this._config.intervalSec;
    this._state.quotePrecision = this._getQuoteStep().toString();
    this._state.basePrecision = this._getBaseStep().toString();

    if (this._state.stopLossClientOrderId) {
      await this._triggerStopLoss(await this._getCurrentPrice());
      return;
    }

    let buysFilled = 0;
    let sellsFilled = 0;
    let ordersKept = 0;
    let ordersDead = 0;
    let activeOrderIds: Set<string> | undefined;
    const onTheBook = async () =>
      (activeOrderIds ??= await this._getActiveOrderIds());

    // Check buy orders on each level
    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (buyOrderId.startsWith("dry-")) {
          ordersKept++;
          continue;
        }
        try {
          const order = (await this._client!.getOrder(buyOrderId)).data;
          if (!(await this._isFinished(order, onTheBook))) {
            ordersKept++;
          } else if (this._bookSafetyOrder(level, order)) {
            buysFilled++;
          } else {
            ordersDead++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          if (!(err instanceof NotFoundError)) {
            throw new Error(
              `Unable to reconcile safety order ${buyOrderId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          level.buyOrderIds = level.buyOrderIds.filter(
            (id) => id !== buyOrderId,
          );
          ordersDead++;
        }
        await sleep(ORDER_DELAY_MS);
      }
    }

    // Check TP sell order
    if (this._state.tpOrderId && !this._state.tpOrderId.startsWith("dry-")) {
      try {
        const order = (await this._client!.getOrder(this._state.tpOrderId))
          .data;
        if (!(await this._isFinished(order, onTheBook))) {
          ordersKept++;
        } else {
          const tpPrice = this._takeProfitPrice();
          this._state.tpOrderId = null;
          if (this._hasFill(order)) {
            sellsFilled++;
            this._bookSellFill(order, tpPrice, "tp");
            if (this._sellableBase(tpPrice).isZero()) {
              for (const level of this._state.levels) {
                for (const buyId of [...level.buyOrderIds]) {
                  if (!buyId.startsWith("dry-")) {
                    await this._client!.cancelOrder(buyId).catch(() => {});
                    await sleep(ORDER_DELAY_MS);
                  }
                }
              }
              this._completeTakeProfitCycle();
            }
          } else {
            ordersDead++;
          }
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (!(err instanceof NotFoundError)) {
          throw new Error(
            `Unable to reconcile take-profit order ${this._state.tpOrderId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this._state.tpOrderId = null;
        ordersDead++;
      }
      await sleep(ORDER_DELAY_MS);
    } else if (this._state.tpOrderId?.startsWith("dry-")) {
      ordersKept++;
    }

    saveMartingaleState(this._state);
    console.log(
      renderMartingaleReconciliationSummary(
        buysFilled,
        sellsFilled,
        ordersKept,
        ordersDead,
      ),
    );
    console.log(chalk.dim("  Martingale resumed and state saved.\n"));

    if (buysFilled + sellsFilled > 0) {
      const parts = [`Martingale reconciled: ${this._config.pair}`];
      if (buysFilled > 0)
        parts.push(
          `${buysFilled} buy${buysFilled !== 1 ? "s" : ""} filled offline`,
        );
      if (sellsFilled > 0)
        parts.push(
          `${sellsFilled} sell${sellsFilled !== 1 ? "s" : ""} filled offline`,
        );
      this._notify(parts.join(" | "));
    }
  }

  // --------------- fill accounting ---------------

  private _applyBuyFill(
    level: MartingaleLevelState,
    baseReceived: Decimal,
    quoteCost: Decimal,
    feeQuote: Decimal,
    orderId: string,
    completesLevel = true,
  ): void {
    const state = this._state!;
    const isInitial = !state.inPosition;

    state.totalQty = new Decimal(state.totalQty).plus(baseReceived).toString();
    state.totalCost = new Decimal(state.totalCost).plus(quoteCost).toString();
    state.avgEntryPrice = new Decimal(state.totalCost)
      .div(new Decimal(state.totalQty))
      .toString();
    state.lastBuyPrice = level.price;
    this._addFee(feeQuote);

    if (isInitial) {
      state.inPosition = true;
      state.initialBuyPrice = level.price;
    } else if (completesLevel) {
      state.safetyOrdersFilled++;
    }

    state.stats.totalBuys++;
    const reason: MartingaleTradeEntry["reason"] = isInitial
      ? "initial"
      : "safety";
    this._logTrade(
      "buy",
      level.price,
      baseReceived.toString(),
      orderId,
      reason,
      undefined,
      feeQuote.gt(0) ? feeQuote.toString() : undefined,
    );
  }

  private _applyTpFill(
    quoteProceeds: Decimal,
    feeQuote: Decimal,
    orderId: string,
    sellPrice: Decimal,
  ): void {
    const state = this._state!;
    const totalQty = new Decimal(state.totalQty);
    const totalCost = new Decimal(state.totalCost);
    const revenue = quoteProceeds;
    const profit = revenue.minus(totalCost);

    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
      .plus(profit)
      .toString();
    state.stats.completedCycles++;
    state.stats.totalSells++;
    if (profit.gt(0)) state.stats.winningCycles++;
    this._addFee(feeQuote);
    this._logTrade(
      "sell",
      sellPrice.toString(),
      totalQty.toString(),
      orderId,
      "tp",
      profit.toFixed(2),
      feeQuote.gt(0) ? feeQuote.toString() : undefined,
    );
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
    state.stopLossClientOrderId = undefined;
    state.cycleRealizedPnl = undefined;
    for (const level of state.levels) {
      level.buyOrderIds = [];
      level.filled = false;
    }
  }

  // --------------- stop loss ---------------

  private async _triggerStopLoss(currentPrice: Decimal): Promise<void> {
    await this._cancelOrdersForStopLoss();

    const state = this._state!;
    const heldQty = new Decimal(state.totalQty);
    const sellableBase = this._sellableBase(currentPrice);
    if (sellableBase.gt(0)) {
      if (this._config.dryRun) {
        this._simulateStopLossSell(sellableBase, currentPrice);
      } else {
        const remainingBase = await this._sellForStopLoss(currentPrice);
        if (remainingBase.gt(0)) {
          await this._reportIncompleteStopLoss(
            currentPrice,
            sellableBase,
            remainingBase,
          );
          await this._stopAfterStopLoss(currentPrice);
          return;
        }
      }
    } else {
      this._writeOffUnsellablePosition();
    }
    if (heldQty.gt(0)) state.stats.completedCycles++;

    const soldBase =
      this._config.dryRun || !sellableBase.gt(0)
        ? sellableBase
        : heldQty.minus(state.totalQty);
    const leftoverBase = heldQty.minus(soldBase);
    const cs = this._cs;
    const leftover = leftoverBase.gt(0)
      ? ` ${leftoverBase} base below the exchange minimum stays in the wallet.`
      : "";
    this._notify(
      `Martingale Bot ${state.pair}: STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)}. ` +
        `Sold ${soldBase} base.${leftover} Realized P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}`,
    );
    this._resetCycle();
    await this._stopAfterStopLoss(currentPrice);
  }

  private _writeOffUnsellablePosition(): void {
    const state = this._state!;
    const cost = new Decimal(state.totalCost);
    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
      .minus(cost)
      .toString();
    state.cycleRealizedPnl = new Decimal(state.cycleRealizedPnl ?? 0)
      .minus(cost)
      .toString();
  }

  private async _cancelOrdersForStopLoss(): Promise<void> {
    const state = this._state!;
    const client = this._client;
    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        for (const id of level.buyOrderIds) {
          cancels.push(
            client.cancelOrder(id).catch((err) => rethrowIfInsecureKey(err)),
          );
        }
      }
      if (state.tpOrderId) {
        cancels.push(
          client
            .cancelOrder(state.tpOrderId)
            .catch((err) => rethrowIfInsecureKey(err)),
        );
      }
      await Promise.all(cancels);
    }
    for (const level of state.levels) level.buyOrderIds = [];
    state.tpOrderId = null;
  }

  private _sellableBase(price: Decimal): Decimal {
    const base = new Decimal(this._state!.totalQty).toDecimalPlaces(
      this._getBaseStep().decimalPlaces(),
      Decimal.ROUND_DOWN,
    );
    const belowMinimum =
      base.lt(this._getMinOrderBase()) ||
      base.times(price).lt(this._getMinOrderQuote());
    return belowMinimum ? new Decimal(0) : base;
  }

  private async _sellForStopLoss(currentPrice: Decimal): Promise<Decimal> {
    const state = this._state!;
    for (
      let attempt = 1;
      attempt <= STOP_LOSS_SELL_ATTEMPTS &&
      this._sellableBase(currentPrice).gt(0);
      attempt++
    ) {
      if (attempt > 1) await sleep(STOP_LOSS_RETRY_DELAY_MS);
      const requestedBase = this._sellableBase(currentPrice);
      try {
        state.stopLossClientOrderId ??= randomUUID();
        this._saveRunningState();
        const resp = await this._client!.placeOrder({
          symbol: this._config.pair,
          side: "sell",
          clientOrderId: state.stopLossClientOrderId,
          market: { baseSize: requestedBase.toString() },
        });
        const order = await this._awaitOrderFill(resp.data.venue_order_id);
        if (this._hasFill(order)) {
          this._bookSellFill(order, currentPrice, "sl");
        }
        const remainingBase = this._sellableBase(currentPrice);
        state.stopLossClientOrderId = remainingBase.isZero()
          ? undefined
          : randomUUID();
        this._saveRunningState();
        if (remainingBase.gt(0)) {
          this._warnings.push(
            `Stop-loss market sell ${order.status}: ${requestedBase.minus(remainingBase)} of ${requestedBase} sold ` +
              `(attempt ${attempt}/${STOP_LOSS_SELL_ATTEMPTS})`,
          );
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        this._warnings.push(
          `Stop-loss market sell failed (attempt ${attempt}/${STOP_LOSS_SELL_ATTEMPTS}): ${errMsg}`,
        );
      }
    }
    return this._sellableBase(currentPrice);
  }

  private _bookSellFill(
    order: OrderDetails,
    sellPrice: Decimal,
    reason: "tp" | "sl",
  ): SaleBooking {
    const state = this._state!;
    const { baseDelivered, quoteProceeds, feeQuote } = this._sellEconomics(
      order,
      sellPrice,
    );
    const price = averageFillPrice(order, sellPrice);
    const soldBase = Decimal.min(baseDelivered, new Decimal(state.totalQty));
    const profit = quoteProceeds.minus(this._releaseCost(soldBase, sellPrice));
    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
      .plus(profit)
      .toString();
    state.cycleRealizedPnl = new Decimal(state.cycleRealizedPnl ?? 0)
      .plus(profit)
      .toString();
    state.stats.totalSells++;
    this._addFee(feeQuote);
    this._logTrade(
      "sell",
      price.toString(),
      soldBase.toString(),
      order.id,
      reason,
      profit.toFixed(2),
      feeQuote.gt(0) ? feeQuote.toString() : undefined,
    );
    return { soldBase, profit, feeQuote, price };
  }

  private _completeTakeProfitCycle(): void {
    const state = this._state!;
    state.stats.completedCycles++;
    if (new Decimal(state.cycleRealizedPnl ?? 0).gt(0)) {
      state.stats.winningCycles++;
    }
    this._resetCycle();
  }

  private _bookSafetyOrder(
    level: MartingaleLevelState,
    order: OrderDetails,
  ): SafetyOrderBooking | null {
    level.buyOrderIds = level.buyOrderIds.filter((id) => id !== order.id);
    if (level.filled || !this._hasFill(order)) {
      return null;
    }
    const levelPrice = new Decimal(level.price);
    const { baseReceived, quoteCost, feeQuote } = this._buyEconomics(
      order,
      levelPrice,
    );
    const unfilledQuote = Decimal.max(
      new Decimal(0),
      new Decimal(level.quoteSize).minus(this._filledAmount(order, levelPrice)),
    ).toDecimalPlaces(this._getQuoteStep().decimalPlaces(), Decimal.ROUND_DOWN);
    const completesLevel =
      FILLED_STATUSES.has(order.status) ||
      !unfilledQuote.gt(0) ||
      unfilledQuote.lt(this._getMinOrderQuote());
    if (completesLevel) {
      level.filled = true;
    } else {
      level.quoteSize = unfilledQuote.toString();
    }
    this._applyBuyFill(
      level,
      baseReceived,
      quoteCost,
      feeQuote,
      order.id,
      completesLevel,
    );
    return {
      baseReceived,
      feeQuote,
      remainingQuote: completesLevel ? new Decimal(0) : unfilledQuote,
    };
  }

  private _takeProfitPrice(): Decimal {
    return new Decimal(this._state!.avgEntryPrice)
      .times(new Decimal(1).plus(new Decimal(this._config.takeProfit)))
      .toDecimalPlaces(this._getQuoteStep().decimalPlaces(), Decimal.ROUND_UP);
  }

  private _releaseCost(soldBase: Decimal, price: Decimal): Decimal {
    const state = this._state!;
    const heldQty = new Decimal(state.totalQty);
    const heldCost = new Decimal(state.totalCost);
    state.totalQty = Decimal.max(
      new Decimal(0),
      heldQty.minus(soldBase),
    ).toString();
    const releasedCost = this._sellableBase(price).isZero()
      ? heldCost
      : heldCost.times(soldBase).div(heldQty);
    state.totalCost = heldCost.minus(releasedCost).toString();
    return releasedCost;
  }

  private _simulateStopLossSell(
    heldBase: Decimal,
    currentPrice: Decimal,
  ): void {
    const state = this._state!;
    const grossRevenue = heldBase.times(currentPrice);
    const feeQuote = grossRevenue.times(TAKER_FEE_RATE);
    const revenue = grossRevenue
      .minus(feeQuote)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const profit = revenue.minus(new Decimal(state.totalCost));
    this._addFee(feeQuote);
    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
      .plus(profit)
      .toString();
    state.stats.totalSells++;
    this._logTrade(
      "sell",
      currentPrice.toString(),
      heldBase.toString(),
      "dry-sl",
      "sl",
      profit.toFixed(2),
      feeQuote.gt(0) ? feeQuote.toFixed(2) : undefined,
    );
  }

  private async _reportIncompleteStopLoss(
    currentPrice: Decimal,
    heldBase: Decimal,
    remainingBase: Decimal,
  ): Promise<void> {
    const pair = this._config.pair;
    const base = pair.split("-")[0] ?? "";
    const cs = this._cs;
    const remainingCost = new Decimal(this._state!.totalCost);
    const msg =
      `STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)} but the market sell did not complete. ` +
      `Sold ${heldBase.minus(remainingBase)} of ${heldBase} ${base}; ` +
      `still holding ${remainingBase} ${base} (cost ${cs}${remainingCost.toFixed(2)}). ` +
      `Bot stopped — restart to retry the stop-loss.`;
    this._warnings.push(msg);
    console.log(chalk.red(`\n  ✗ ${msg}`));
    await this._notifyAndWait(`🚨 Martingale ${pair}: ${msg}`);
  }

  private async _stopAfterStopLoss(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
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
          console.log(
            chalk.red(
              `\n  Halting: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
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
          console.log(
            chalk.red(
              `\n  Halting: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
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

  private async _paceSleep(
    cycleStart: number,
    paceIntervalSec: number | undefined,
  ): Promise<void> {
    if (paceIntervalSec === undefined) return;
    const elapsed = (performance.now() - cycleStart) / 1000;
    const delay = Math.max(0, paceIntervalSec - elapsed) * 1000;
    if (delay <= 0) return;
    await new Promise<void>((resolve) => {
      this._timer = setTimeout(() => {
        this._timer = null;
        resolve();
      }, delay);
    });
  }

  // --------------- tick ---------------

  private async _tick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client!;
    this._warnings = [];
    this._connections = loadConnections().filter((c) => c.enabled);
    this._currentPrice = currentPrice;

    // 0. If not in position, start a new market-entry cycle.
    if (!state.inPosition && this._lifecycle === "running") {
      if (this._config.dryRun) {
        await this._startCycle(currentPrice);
        this._saveRunningState();
        this._tickCount++;
        return;
      } else {
        try {
          if (!(await this._startCycle(currentPrice))) return;
          this._saveRunningState();
          this._tickCount++;
          return;
        } catch (err) {
          rethrowIfInsecureKey(err);
          await this._handleCannotPlaceOrder(
            "ENTRY",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
      }
    }

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
      throw new Error(
        `Failed to fetch active orders: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3. Check buy order fills
    for (const level of state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (activeOrderIds.has(buyOrderId)) continue;
        try {
          const order = (await client.getOrder(buyOrderId)).data;
          if (!(await this._isFinished(order))) continue;
          const booked = this._bookSafetyOrder(level, order);
          if (booked) {
            this._notifySafetyOrderFill(level, order, booked);
            if (state.tpOrderId) {
              try {
                await client.cancelOrder(state.tpOrderId);
              } catch {}
              state.tpOrderId = null;
            }
            await this._placeTpOrder();
          }
          if (!level.filled) {
            const minQuote = this._getMinOrderQuote();
            if (new Decimal(level.quoteSize).gte(minQuote)) {
              try {
                const orderId = await this._placeBuyOrder(level);
                level.buyOrderIds.push(orderId);
              } catch (err) {
                rethrowIfInsecureKey(err);
                await this._handleCannotPlaceOrder(
                  `SO#${level.index + 1} (re-place)`,
                  err instanceof Error ? err.message : String(err),
                );
                return;
              }
            }
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // 4. Check TP sell order
    if (state.tpOrderId && !activeOrderIds.has(state.tpOrderId)) {
      try {
        const order = (await client.getOrder(state.tpOrderId)).data;
        if (await this._isFinished(order)) {
          const tpPrice = this._takeProfitPrice();
          state.tpOrderId = null;
          const sold = this._hasFill(order)
            ? this._bookSellFill(order, tpPrice, "tp")
            : null;
          if (sold && this._sellableBase(tpPrice).isZero()) {
            this._notifyTakeProfit(sold);
            await Promise.all(
              state.levels.flatMap((level) =>
                level.buyOrderIds.map((id) =>
                  client.cancelOrder(id).catch(() => {}),
                ),
              ),
            );
            this._completeTakeProfitCycle();
            try {
              if (!(await this._startCycle(currentPrice))) return;
            } catch (err) {
              rethrowIfInsecureKey(err);
              await this._handleCannotPlaceOrder(
                "ENTRY",
                err instanceof Error ? err.message : String(err),
              );
              return;
            }
          } else {
            if (sold) this._notifyPartialTakeProfit(sold);
            await this._placeTpOrder();
          }
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._warnings.push(
          `Check TP: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 5. Safety order recovery: re-place every unfilled SO that lost its order
    //    (e.g. bot crashed, order was cancelled). All SOs run simultaneously so
    //    we re-arm each missing one independently without a predecessor check.
    if (state.inPosition) {
      for (let i = 1; i < state.levels.length; i++) {
        const lv = state.levels[i];
        if (!lv.filled && lv.buyOrderIds.length === 0) {
          try {
            const orderId = await this._placeBuyOrder(lv);
            lv.buyOrderIds.push(orderId);
          } catch (err) {
            rethrowIfInsecureKey(err);
            await this._handleCannotPlaceOrder(
              `SO#${i} (recovery)`,
              err instanceof Error ? err.message : String(err),
            );
            return;
          }
        }
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
      this._applyBuyFill(
        level,
        filledQty,
        quoteSize,
        new Decimal(0),
        `dry-buy-${randomUUID().slice(0, 8)}`,
      );

      const base = this._config.pair.split("-")[0] ?? "";
      const cs = this._cs;
      this._notify(
        `Martingale ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${filledQty} ${base} [DRY RUN]`,
      );

      // Next SOs are already armed (all placed simultaneously at start).
      state.tpOrderId = `dry-sell-tp-${randomUUID().slice(0, 8)}`;
    }

    // After buy fills: re-check stop-loss (price may have dropped below SL in same tick as entry)
    if (
      state.inPosition &&
      state.stopLossPrice &&
      currentPrice.lte(new Decimal(state.stopLossPrice))
    ) {
      await this._triggerStopLoss(currentPrice);
      return;
    }

    // Simulate TP fill — use the same rounded tpPrice as _placeTpOrder (live) and the backtest engine.
    if (state.tpOrderId && state.inPosition) {
      const tpPrice = new Decimal(state.avgEntryPrice)
        .times(new Decimal(1).plus(new Decimal(this._config.takeProfit)))
        .toDecimalPlaces(
          this._getQuoteStep().decimalPlaces(),
          Decimal.ROUND_UP,
        );
      if (currentPrice.gte(tpPrice)) {
        const totalQty = new Decimal(state.totalQty);
        const revenue = totalQty
          .times(tpPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const profit = revenue.minus(new Decimal(state.totalCost));

        const cs = this._cs;
        this._notify(
          `Martingale ${this._config.pair}: TAKE PROFIT @ ${cs}${tpPrice.toFixed(2)} | ` +
            `profit ${cs}${profit.toFixed(2)} [DRY RUN]`,
        );

        state.tpOrderId = null;
        this._applyTpFill(
          revenue,
          new Decimal(0),
          `dry-sell-${randomUUID().slice(0, 8)}`,
          tpPrice,
        );

        await this._startCycle(currentPrice);
      }
    }

    // Safety order recovery: re-arm every unfilled SO that has no active order
    // (no predecessor check — all SOs run simultaneously)
    if (state.inPosition) {
      for (let i = 1; i < state.levels.length; i++) {
        const lv = state.levels[i];
        if (!lv.filled && lv.buyOrderIds.length === 0) {
          lv.buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
        }
      }
    }

    this._saveRunningState();
  }

  // --------------- order placement ---------------

  /**
   * Execute the market entry for the given level (level[0]).
   * In dry-run, fill is simulated at currentPrice. In live mode, a market buy
   * is placed immediately and awaited. Either way, _applyBuyFill is called so
   * state (inPosition, avgEntry, totalQty, etc.) is updated before returning.
   */
  private async _startCycle(referencePrice: Decimal): Promise<boolean> {
    this._anchorCycle(referencePrice);
    if (!(await this._placeMarketEntry(referencePrice))) return false;
    await this._placeTpOrder();
    return this._placeAllSafetyOrders(this._state!.levels);
  }

  private _anchorCycle(entryPrice: Decimal): void {
    const state = this._state!;
    state.levels = this._buildLevels(entryPrice);
    state.stopLossPrice = this._computeSlPrice(entryPrice).toString();
  }

  private async _placeMarketEntry(referencePrice: Decimal): Promise<boolean> {
    const state = this._state!;
    const cs = this._cs;
    const base = this._config.pair.split("-")[0] ?? "";
    const level = state.levels[0];

    if (this._config.dryRun) {
      const baseStep = this._getBaseStep();
      const quoteSize = new Decimal(level.quoteSize);
      const feeQuote = quoteSize.times(TAKER_FEE_RATE);
      const filledQty = quoteSize
        .div(referencePrice)
        .times(new Decimal(1).minus(TAKER_FEE_RATE))
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      const orderId = `dry-market-${randomUUID().slice(0, 8)}`;
      level.filled = true;
      this._applyBuyFill(level, filledQty, quoteSize, feeQuote, orderId);
      const feeStr = feeQuote.gt(0) ? ` | fee ${cs}${feeQuote.toFixed(2)}` : "";
      this._notify(
        `Martingale ${this._config.pair}: ENTRY (market) @ ${cs}${referencePrice.toFixed(2)} | ` +
          `${filledQty} ${base} | avg ${cs}${new Decimal(state.avgEntryPrice).toFixed(2)}${feeStr} [DRY RUN]`,
      );
      return true;
    }

    const resp = await this._client!.placeOrder({
      symbol: this._config.pair,
      side: "buy",
      market: { quoteSize: level.quoteSize },
    });
    const order = await this._awaitOrderFill(resp.data.venue_order_id);
    if (!this._hasFill(order)) {
      throw new Error(
        `Entry market order ${order.status} without a fill: ${order.id}`,
      );
    }
    const fillPrice = averageFillPrice(order, referencePrice);
    this._anchorCycle(fillPrice);
    const entryLevel = state.levels[0];
    const { baseReceived, quoteCost, feeQuote } = this._buyEconomics(
      order,
      fillPrice,
    );
    entryLevel.filled = true;
    this._applyBuyFill(entryLevel, baseReceived, quoteCost, feeQuote, order.id);

    if (!FILLED_STATUSES.has(order.status)) {
      await this._haltOnPartialEntry(order, fillPrice);
      return false;
    }

    const quoteDp = this._getQuoteStep().decimalPlaces();
    const feeStr = feeQuote.gt(0) ? ` | fee ${cs}${feeQuote.toFixed(2)}` : "";
    this._notify(
      `Martingale ${this._config.pair}: ENTRY (market) @ ${cs}${fillPrice.toFixed(quoteDp)} | ` +
        `${baseReceived} ${base} | avg ${cs}${new Decimal(state.avgEntryPrice).toFixed(quoteDp)}${feeStr}`,
    );
    return true;
  }

  private async _haltOnPartialEntry(
    order: OrderDetails,
    fillPrice: Decimal,
  ): Promise<void> {
    const state = this._state!;
    const pair = this._config.pair;
    const base = pair.split("-")[0] ?? "";
    const cs = this._cs;
    const quoteDp = this._getQuoteStep().decimalPlaces();
    const spent = this._filledAmount(order, fillPrice).toFixed(quoteDp);
    const msg =
      `Entry market order only partially filled: ${cs}${spent} of ${cs}${state.levels[0].quoteSize}, ` +
      `${state.totalQty} ${base} @ ${cs}${fillPrice.toFixed(quoteDp)}. ` +
      `Bot stopped — no safety orders or take-profit placed.`;
    this._warnings.push(msg);
    console.log(chalk.red(`\n  ✗ ${msg}`));
    await this._notifyAndWait(`🚨 Martingale ${pair}: ${msg}`);
    this._lifecycle = "stopped";
    this._saveRunningState();
    this.stop();
  }

  /**
   * Place ALL unfilled safety orders (levels 1..maxSO) simultaneously via
   * Promise.allSettled. On any failure the bot stops via _handleCannotPlaceOrder
   * and the method returns false; returns true on full success.
   */
  private async _placeAllSafetyOrders(
    levels: MartingaleLevelState[],
  ): Promise<boolean> {
    if (this._config.dryRun) {
      for (let i = 1; i < levels.length; i++) {
        if (!levels[i].filled && levels[i].buyOrderIds.length === 0) {
          levels[i].buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
        }
      }
      return true;
    }

    const soLevels = levels.filter(
      (lv) => lv.index > 0 && !lv.filled && lv.buyOrderIds.length === 0,
    );

    const results = await Promise.allSettled(
      soLevels.map(async (lv) => {
        const orderId = await this._placeBuyOrder(lv);
        lv.buyOrderIds.push(orderId);
      }),
    );

    const firstFailure = results.find((r) => r.status === "rejected");
    if (firstFailure && firstFailure.status === "rejected") {
      const err = firstFailure.reason as unknown;
      rethrowIfInsecureKey(err);
      await this._handleCannotPlaceOrder(
        "SO",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    return true;
  }

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
    const orderId = resp.data.venue_order_id;
    this._notify(
      `Martingale ${this._config.pair}: SO#${level.index} placed @ ${this._cs}${level.price} | ${this._cs}${level.quoteSize}`,
    );
    return orderId;
  }

  private async _placeTpOrder(): Promise<void> {
    const state = this._state!;
    if (!state.inPosition || new Decimal(state.totalQty).lte(0)) return;

    const tpPrice = this._takeProfitPrice();

    const totalQty = new Decimal(state.totalQty).toDecimalPlaces(
      this._getBaseStep().decimalPlaces(),
      Decimal.ROUND_DOWN,
    );

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
      this._tpFailureCount = 0; // reset on success
      const quoteDp = this._getQuoteStep().decimalPlaces();
      const baseDp = this._getBaseStep().decimalPlaces();
      this._notify(
        `Martingale ${this._config.pair}: TP placed @ ${this._cs}${tpPrice.toFixed(quoteDp)} | qty ${totalQty.toFixed(baseDp)}`,
      );
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._tpFailureCount++;
      const errMsg = err instanceof Error ? err.message : String(err);
      this._warnings.push(
        `TP order @${tpPrice}: ${errMsg} (${this._tpFailureCount}/3)`,
      );
      if (this._tpFailureCount >= 3) {
        await this._handleOrderFailureLimit("TP", tpPrice.toString());
        return;
      }
    }
  }

  // --------------- awaiting fills ---------------

  private async _isFinished(
    order: OrderDetails,
    onTheBook: () => Promise<Set<string>> = () => this._getActiveOrderIds(),
  ): Promise<boolean> {
    if (FILLED_STATUSES.has(order.status) || DEAD_STATUSES.has(order.status)) {
      return true;
    }
    return (
      order.status === PARTIALLY_FILLED_STATUS &&
      !(await onTheBook()).has(order.id)
    );
  }

  private _hasFill(order: OrderDetails): boolean {
    return new Decimal(order.filled_quantity || 0).gt(0);
  }

  private async _awaitOrderFill(
    orderId: string,
    timeoutMs = 30_000,
  ): Promise<OrderDetails> {
    const client = this._client!;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const order = (await client.getOrder(orderId)).data;
        if (await this._isFinished(order)) return order;
      } catch (err) {
        rethrowIfInsecureKey(err);
      }
      await sleep(500);
    }
    throw new Error(
      `Order did not fill within ${timeoutMs / 1000}s: ${orderId}`,
    );
  }

  private async _getActiveOrderIds(): Promise<Set<string>> {
    const activeOrderIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this._client!.getActiveOrders({
        symbols: [this._config.pair],
        cursor,
        limit: 100,
      });
      for (const order of response.data) {
        activeOrderIds.add(order.id);
      }
      cursor = response.metadata?.next_cursor as string | undefined;
    } while (cursor);
    return activeOrderIds;
  }

  // --------------- fees ---------------

  private _filledAmount(order: OrderDetails, fallbackPrice: Decimal): Decimal {
    return filledAmount(order, fallbackPrice);
  }

  private _buyEconomics(
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): BuyEconomics {
    return buyEconomics(order, fallbackPrice, this._config.pair);
  }

  private _sellEconomics(
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): SellEconomics {
    return sellEconomics(order, fallbackPrice, this._config.pair);
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
    const unrealized = position.gt(0)
      ? position.times(currentPrice).minus(costBasis)
      : new Decimal(0);
    const totalPnl = realizedPnl.plus(unrealized);
    const netValue = new Decimal(state.config.investment).plus(totalPnl);

    let openOrders = 0;
    for (const level of state.levels) openOrders += level.buyOrderIds.length;
    if (state.tpOrderId) openOrders++;

    return {
      position,
      realizedPnl,
      unrealized,
      totalPnl,
      netValue,
      openOrders,
    };
  }

  // --------------- state & rendering ---------------

  private _saveRunningState(): void {
    const state = this._state!;
    if (this._statusReporter)
      state.statusMessages = this._statusReporter.snapshot();
    saveMartingaleState(state);
  }

  private _emitTickEvent(price: Decimal, timestamp: number): void {
    if (!this._onTick || !this._state) return;
    const fills: string[] = [];
    const newEntries = this._state.tradeLog.slice(this._tradeLogStart);
    for (const e of newEntries) {
      fills.push(
        `${e.side.toUpperCase()} ${e.quantity}@${e.price} [${e.reason}]`,
      );
    }
    const { position, realizedPnl, unrealized, openOrders } =
      this._computePnl(price);
    const state = this._state;
    this._onTick({
      index: this._tickCount,
      timestamp,
      price,
      fills,
      position,
      avgEntryPrice: state.inPosition
        ? new Decimal(state.avgEntryPrice)
        : new Decimal(0),
      realizedPnl,
      unrealizedPnl: unrealized,
      tpPrice:
        state.tpOrderId && state.avgEntryPrice !== "0"
          ? new Decimal(state.avgEntryPrice).times(
              new Decimal(1).plus(new Decimal(this._config.takeProfit)),
            )
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
    const { position, realizedPnl, unrealized, totalPnl, netValue } =
      this._computePnl(price);
    const investment = new Decimal(state.config.investment);
    const totalPct = investment.gt(0)
      ? totalPnl.div(investment).times(100)
      : new Decimal(0);

    let glyph: string;
    let label: string;
    if (this._lifecycle === "finished") {
      glyph = "✅";
      label = "Finished";
    } else if (this._lifecycle === "stopped") {
      glyph = "\u{1f534}";
      label = "Stopped (stop-loss)";
    } else {
      glyph = "\u{1f7e2}";
      const dir = totalPnl.gt(0) ? "▲" : totalPnl.lt(0) ? "▼" : "━";
      label = `Running ${dir} ${totalPct.gte(0) ? "+" : ""}${totalPct.toFixed(2)}%`;
    }

    const mode = state.config.dryRun ? " [DRY RUN]" : "";
    const base = state.pair.split("-")[0] ?? "";
    const s = state.stats;
    const tpPrice =
      state.inPosition && state.avgEntryPrice !== "0"
        ? new Decimal(state.avgEntryPrice).times(
            new Decimal(1).plus(new Decimal(state.config.takeProfit)),
          )
        : null;

    const soBar = Array.from(
      { length: state.config.maxSafetyOrders + 1 },
      (_, i) => {
        if (i < state.safetyOrdersFilled + (state.inPosition ? 1 : 0))
          return "■"; // filled
        if ((state.levels[i]?.buyOrderIds.length ?? 0) > 0) return "▒"; // placed, not filled
        return "□"; // not placed
      },
    ).join("");

    const body = [
      `${glyph} Martingale ${state.pair}${mode}  ${label}`,
      `Price ${fmtPrice(price, cs)} · Pos ${position.toFixed()} ${base}`,
      state.inPosition
        ? `Avg Entry ${fmtPrice(new Decimal(state.avgEntryPrice), cs)} · SO [${soBar}]`
        : `Waiting for entry · SO [${soBar}]`,
      tpPrice
        ? `TP ${fmtPrice(tpPrice, cs)} · SL ${state.stopLossPrice ? fmtPrice(new Decimal(state.stopLossPrice), cs) : "—"}`
        : "",
      `Realized ${fmtSignedPnl(realizedPnl, cs)} · Unreal ${fmtSignedPnl(unrealized, cs)}`,
      `Total ${fmtSignedPnl(totalPnl, cs)} · Net ${fmtMoney(netValue, cs)}`,
      `Cycles ${s.completedCycles} (${s.winningCycles} wins) · Up ${fmtUptime(Date.now() - this._startTime)}`,
      "",
      `Updated ${fmtLocalDateTime()}`,
    ]
      .filter(Boolean)
      .join("\n");

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

  private _notifySafetyOrderFill(
    level: MartingaleLevelState,
    order: OrderDetails,
    booked: SafetyOrderBooking,
  ): void {
    const base = this._config.pair.split("-")[0] ?? "";
    const cs = this._cs;
    const avg = new Decimal(this._state!.avgEntryPrice).toFixed(2);
    const feeStr = booked.feeQuote.gt(0)
      ? ` | fee ${cs}${booked.feeQuote.toFixed(2)}`
      : "";
    if (FILLED_STATUSES.has(order.status)) {
      this._notify(
        `Martingale ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${booked.baseReceived} ${base} | ` +
          `avg entry ${cs}${avg}${feeStr}`,
      );
      return;
    }
    const remainder = booked.remainingQuote.gt(0)
      ? `remaining ${cs}${booked.remainingQuote} back on the book`
      : "level complete";
    this._notify(
      `Martingale ${this._config.pair}: BUY partly filled @ ${cs}${level.price} | ${booked.baseReceived} ${base} | ` +
        `avg entry ${cs}${avg}${feeStr} | ${remainder}`,
    );
  }

  private _notifyTakeProfit(sale: SaleBooking): void {
    const state = this._state!;
    const cs = this._cs;
    const feeStr = sale.feeQuote.gt(0)
      ? ` | fee ${cs}${sale.feeQuote.toFixed(2)}`
      : "";
    this._notify(
      `Martingale ${this._config.pair}: TAKE PROFIT @ ${cs}${sale.price.toFixed(2)} | ` +
        `profit ${cs}${new Decimal(state.cycleRealizedPnl ?? 0).toFixed(2)} | ` +
        `total P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}${feeStr}`,
    );
  }

  private _notifyPartialTakeProfit(sale: SaleBooking): void {
    const base = this._config.pair.split("-")[0] ?? "";
    const cs = this._cs;
    this._notify(
      `Martingale ${this._config.pair}: TAKE PROFIT partly filled @ ${cs}${sale.price.toFixed(2)} | ` +
        `sold ${sale.soldBase} ${base} | P&L ${cs}${sale.profit.toFixed(2)} | ` +
        `still holding ${this._state!.totalQty} ${base}`,
    );
  }

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
      this._connections.map((tc) =>
        sendWithRetries(tc.bot_token, tc.chat_id, message),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.success)
        this._lastNotifyOk = Date.now();
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
    const entry: MartingaleTradeEntry = {
      ts: new Date().toISOString(),
      side,
      price,
      quantity,
      orderId,
      reason,
    };
    if (profit !== undefined) entry.profit = profit;
    if (fee !== undefined) entry.fee = fee;
    this._state!.tradeLog.push(entry);
  }
}
