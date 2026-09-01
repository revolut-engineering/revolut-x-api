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
  saveGridState,
  loadGridState,
  deleteGridState,
  type GridState,
  type GridLevelState,
  type GridLevelPosition,
  type GridTradeEntry,
} from "../db/grid-store.js";
import { loadConnections, type TelegramConnection } from "../db/store.js";
import { sendWithRetries } from "./notify.js";
import { LiveStatusReporter } from "./live-status.js";
import {
  renderDashboard,
  renderShutdownSummary,
  renderReconciliationSummary,
  getCurrSymbol,
  fmtUptime,
  fmtPrice,
  fmtSignedPnl,
  fmtMoney,
  renderOrderLadder,
  renderRiskLine,
  renderStartedMessage,
  type DashboardData,
} from "./grid-renderer.js";
import {
  TAKER_FEE_RATE,
  levelsPerSide,
  trailUpTriggerPrice,
} from "./grid-math.js";
import {
  allocateBaseOrderSizes,
  constraintsFromPair,
  createGridPlan,
  floorToStep,
  normalizeBaseOrderSize,
  roundToStep,
  type GridOrderConstraints,
} from "./grid-plan.js";
import { ExchangeRateLimiter } from "./exchange-rate-limiter.js";

export interface GridBotConfig {
  pair: string;
  levels: number;
  rangePct: string;
  investment: string;
  splitInvestment: boolean;
  intervalSec: number;
  dryRun: boolean;
  reset: boolean;
  trailingUp: boolean;
  stopLoss?: string;
}

export interface GridBotTickEvent {
  index: number;
  timestamp: number;
  price: Decimal;
  fills: string[];
  position: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  openOrders: number;
}

export interface GridExchangeRateLimiter {
  place<T>(operation: () => Promise<T>): Promise<T>;
  cancel<T>(operation: () => Promise<T>): Promise<T>;
  query<T>(operation: () => Promise<T>): Promise<T>;
}

export interface GridBotOptions {
  priceSource?: LivePriceSource;
  onTick?: (event: GridBotTickEvent) => void;
  suppressDashboard?: boolean;
  humanOutput?: NodeJS.WritableStream;
  rateLimiter?: GridExchangeRateLimiter;
  persistState?: boolean;
  orderConstraints?: GridOrderConstraints;
}

interface PositionSettlement {
  quantity: Decimal;
  feeQuote: Decimal;
  profit: Decimal;
  costBasis: Decimal;
  remainingBase: Decimal;
}

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const PARTIALLY_FILLED_STATUS = "partially_filled";
const LADDER_MAX_ROWS = 80;

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

export class ForegroundGridBot {
  private _config: GridBotConfig;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _client: RevolutXClient | null = null;
  private _state: GridState | null = null;
  private _startTime = 0;
  private _currentPrice: Decimal | null = null;
  private _tickCount = 0;
  private _lastError: string | null = null;
  private _warnings: string[] = [];
  private _pairInfo: CurrencyPair | null = null;
  private _connections: TelegramConnection[] = [];
  private _boundaryAlerted = false;
  private _shouldRebuildUp = false;
  private _lastNotifyOk = 0;
  private _cs: string;
  private _priceSource: LivePriceSource | null = null;
  private _onTick: ((event: GridBotTickEvent) => void) | null = null;
  private _tradeLogStart = 0;
  private _suppressDashboard = false;
  private _statusReporter: LiveStatusReporter | null = null;
  private _lifecycle: "running" | "finished" | "stopped" = "running";
  private readonly _rateLimiter: GridExchangeRateLimiter;
  private readonly _persistState: boolean;
  private readonly _orderConstraints: GridOrderConstraints | null;
  private readonly _humanOutput: NodeJS.WritableStream;

  constructor(config: GridBotConfig, options: GridBotOptions = {}) {
    this._config = config;
    this._cs = getCurrSymbol(config.pair);
    this._priceSource = options.priceSource ?? null;
    this._onTick = options.onTick ?? null;
    this._suppressDashboard = options.suppressDashboard === true;
    this._rateLimiter = options.rateLimiter ?? new ExchangeRateLimiter();
    this._persistState = options.persistState !== false;
    this._orderConstraints = options.orderConstraints ?? null;
    this._humanOutput = options.humanOutput ?? process.stdout;
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _saveGridState(state: GridState): void {
    if (this._persistState) {
      saveGridState(state);
    }
  }

  private _deleteGridState(pair: string): void {
    if (this._persistState) {
      deleteGridState(pair);
    }
  }

  private _log(message: string): void {
    this._humanOutput.write(`${message}\n`);
  }

  private async _cancelOrderWithoutFill(orderId: string): Promise<void> {
    await this._rateLimiter.cancel(() => this._client!.cancelOrder(orderId));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let order: OrderDetails;
      try {
        const response = await this._rateLimiter.query(() =>
          this._client!.getOrder(orderId),
        );
        order = response.data;
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (err instanceof NotFoundError) return;
        throw err;
      }
      if (this._hasFilledQuantity(order)) {
        throw new Error(
          `Order ${orderId} executed ${order.filled_quantity} before cancellation and must be reconciled.`,
        );
      }
      if (DEAD_STATUSES.has(order.status)) return;
      await sleep(100);
    }
    throw new Error(`Order ${orderId} did not reach a cancelled state.`);
  }

  private async _cancelTrackedOrdersForReset(
    savedState: GridState,
  ): Promise<void> {
    if (!savedState.config.dryRun && this._hasTrackedInventory(savedState)) {
      throw new Error(
        "Cannot reset grid while it owns acquired base. Resume the grid and close its positions before retrying --reset.",
      );
    }
    const hasUnresolvedPlacement =
      (!!savedState.splitClientOrderId && !savedState.splitOrderId) ||
      !!savedState.stopLossClientOrderId ||
      savedState.levels.some(
        (level) =>
          (level.pendingBuyClientOrderIds?.length ?? 0) > 0 ||
          level.positions.some(
            (position) => !!position.sellClientOrderId && !position.sellOrderId,
          ),
      );
    if (hasUnresolvedPlacement) {
      throw new Error(
        "Cannot reset grid while an idempotent order placement is unresolved. Resume the grid first, then retry --reset.",
      );
    }

    const cancellationErrors: string[] = [];
    const cancellations: Promise<void>[] = [];
    const cancelAndConfirm = async (
      orderId: string,
      clearOrder: () => void,
    ): Promise<void> => {
      try {
        await this._cancelOrderWithoutFill(orderId);
        clearOrder();
      } catch (err) {
        rethrowIfInsecureKey(err);
        cancellationErrors.push(
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    for (const level of savedState.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (savedState.config.dryRun) {
          this._removeBuyOrder(level, buyOrderId);
          continue;
        }
        cancellations.push(
          cancelAndConfirm(buyOrderId, () =>
            this._removeBuyOrder(level, buyOrderId),
          ),
        );
      }
      for (const position of level.positions) {
        const sellOrderId = position.sellOrderId;
        if (!sellOrderId) continue;
        if (savedState.config.dryRun) {
          position.sellOrderId = null;
          position.sellBaseSize = undefined;
          position.sellClientOrderId = undefined;
          continue;
        }
        cancellations.push(
          cancelAndConfirm(sellOrderId, () => {
            position.sellOrderId = null;
            position.sellBaseSize = undefined;
            position.sellClientOrderId = undefined;
          }),
        );
      }
    }
    if (savedState.splitOrderId) {
      cancellations.push(
        cancelAndConfirm(savedState.splitOrderId, () => {
          savedState.splitOrderId = undefined;
          savedState.splitClientOrderId = undefined;
        }),
      );
    }
    await Promise.all(cancellations);
    this._saveGridState(savedState);
    if (cancellationErrors.length > 0) {
      throw new Error(
        `Cannot reset grid because ${cancellationErrors.length} order cancellation${cancellationErrors.length === 1 ? "" : "s"} failed: ${cancellationErrors[0]}`,
      );
    }
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
    const existingState = loadGridState(this._config.pair);

    if (existingState && this._config.reset) {
      this._log(chalk.dim("  --reset flag: cancelling saved grid orders..."));
      await this._cancelTrackedOrdersForReset(existingState);
      this._deleteGridState(this._config.pair);
      await this._initNewGrid();
    } else if (existingState) {
      const savedLevels = existingState.config.levels;
      const savedRange = existingState.config.rangePct;
      const newLevels = this._config.levels;
      const newRange = this._config.rangePct;

      if (savedLevels !== newLevels || savedRange !== newRange) {
        const savedRangePct = new Decimal(savedRange).times(100).toFixed(1);
        const newRangePct = new Decimal(newRange).times(100).toFixed(1);
        throw new Error(
          `Saved grid has ${levelsPerSide(savedLevels)} levels/side with ${savedRangePct}% range ` +
            `but you requested ${levelsPerSide(newLevels)} levels/side with ${newRangePct}% range. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      const savedSplit = existingState.config.splitInvestment;
      if (savedSplit !== this._config.splitInvestment) {
        throw new Error(
          `Saved grid was started ${savedSplit ? "with" : "without"} --split ` +
            `but you requested ${this._config.splitInvestment ? "with" : "without"} --split. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      if (
        !new Decimal(existingState.config.investment).eq(
          this._config.investment,
        )
      ) {
        throw new Error(
          `Saved grid was started with investment ${existingState.config.investment} ` +
            `but you requested ${this._config.investment}. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      if (existingState.config.dryRun !== this._config.dryRun) {
        throw new Error(
          `Saved grid was started in ${existingState.config.dryRun ? "dry-run" : "live"} mode ` +
            `but you requested ${this._config.dryRun ? "dry-run" : "live"} mode. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      if (
        Boolean(existingState.config.trailingUp) !== this._config.trailingUp
      ) {
        throw new Error(
          `Saved grid was started ${existingState.config.trailingUp ? "with" : "without"} --trailing-up ` +
            `but you requested ${this._config.trailingUp ? "with" : "without"} --trailing-up. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      const savedStopLoss = existingState.config.stopLoss;
      const newStopLoss = this._config.stopLoss;
      const stopLossMismatch =
        (savedStopLoss == null) !== (newStopLoss == null) ||
        (savedStopLoss != null &&
          newStopLoss != null &&
          !new Decimal(savedStopLoss).eq(newStopLoss));
      if (stopLossMismatch) {
        throw new Error(
          `Saved grid was started with stop-loss ${savedStopLoss ?? "(none)"} ` +
            `but you requested ${newStopLoss ?? "(none)"}. ` +
            `Use --reset to discard saved state and start fresh.`,
        );
      }

      await this._reconcileAndInit(existingState);
      if (!this._running) return;
    } else {
      await this._initNewGrid();
    }
    this._notify(renderStartedMessage(this._state!.pair, this._state!.config));
    if (this._connections.length > 0) {
      this._statusReporter = new LiveStatusReporter({
        connections: this._connections,
        refs: this._state!.statusMessages,
        minIntervalMs: Math.max(5000, this._config.intervalSec * 1000),
        parseMode: "MarkdownV2",
      });
      await this._statusReporter.flush(this._renderStatusCard());
      this._state!.statusMessages = this._statusReporter.snapshot();
      this._saveGridState(this._state!);
    }
    await this._loop();
  }

  async shutdown(): Promise<void> {
    if (!this._state || !this._client) return;

    this._log(chalk.dim("\n  Cancelling open orders..."));
    let cancelled = 0;
    let remaining =
      (this._state.splitClientOrderId || this._state.splitOrderId ? 1 : 0) +
      (this._state.stopLossClientOrderId ? 1 : 0) +
      this._state.levels.reduce(
        (count, level) =>
          count +
          (level.pendingBuyClientOrderIds?.length ?? 0) +
          level.positions.filter(
            (position) => !!position.sellClientOrderId && !position.sellOrderId,
          ).length,
        0,
      );
    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        try {
          if (!this._config.dryRun) {
            await this._cancelOrderWithoutFill(buyOrderId);
          }
          this._removeBuyOrder(level, buyOrderId);
          cancelled++;
        } catch {
          remaining++;
        }
      }
      for (const pos of level.positions) {
        if (pos.sellOrderId) {
          try {
            if (!this._config.dryRun) {
              await this._cancelOrderWithoutFill(pos.sellOrderId!);
            }
            pos.sellOrderId = null;
            pos.sellBaseSize = undefined;
            pos.sellClientOrderId = undefined;
            cancelled++;
          } catch {
            remaining++;
          }
        }
      }
    }

    const hasTrackedInventory =
      !this._state.config.dryRun && this._hasTrackedInventory(this._state);
    if (remaining === 0 && !hasTrackedInventory) {
      this._deleteGridState(this._state.pair);
    } else {
      this._saveGridState(this._state);
    }

    if (cancelled > 0) {
      this._log(
        chalk.dim(
          `  Cancelled ${cancelled} order${cancelled !== 1 ? "s" : ""}`,
        ),
      );
    }

    let currentPrice: Decimal;
    try {
      currentPrice = await this._getCurrentPrice();
    } catch {
      currentPrice = new Decimal(this._state.gridPrice);
    }

    this._log(
      renderShutdownSummary(
        this._state,
        currentPrice,
        remaining,
        hasTrackedInventory,
      ),
    );

    const s = this._state.stats;
    this._currentPrice = currentPrice;
    const { realizedPnl, unrealized, totalPnl, netValue } =
      this._computePnl(currentPrice);

    const cs = this._cs;

    await this._notifyAndWait(
      `Grid Bot stopped: ${this._state.pair}\n` +
        `${s.totalBuys} buys, ${s.totalSells} sells\n` +
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
    const client = this._client!;
    const pairs = await client.getCurrencyPairs();
    const slashPair = this._config.pair.replace("-", "/");
    this._pairInfo = pairs[slashPair] ?? null;
    if (!this._pairInfo) {
      throw new Error(`Pair configuration not found for ${this._config.pair}.`);
    }
  }

  private async _getActiveOrderIds(): Promise<Set<string>> {
    const activeOrderIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this._rateLimiter.query(() =>
        this._client!.getActiveOrders({
          symbols: [this._config.pair],
          cursor,
          limit: 100,
        }),
      );
      for (const order of response.data) {
        activeOrderIds.add(order.id);
      }
      cursor = response.metadata?.next_cursor as string | undefined;
    } while (cursor);
    return activeOrderIds;
  }

  private _getOrderConstraints(): GridOrderConstraints {
    if (this._orderConstraints) {
      return this._orderConstraints;
    }
    if (this._pairInfo) {
      return constraintsFromPair(this._pairInfo);
    }
    return {
      baseStep: this._getBaseStep(),
      quoteStep: this._getQuoteStep(),
      minBase: new Decimal(0),
      maxBase: new Decimal(Infinity),
      minQuote: new Decimal(0),
    };
  }

  private _validateSavedStateOrderConstraints(
    state: GridState,
    constraints: GridOrderConstraints,
  ): void {
    const quotePerLevel = new Decimal(state.quotePerLevel);
    if (
      !floorToStep(quotePerLevel, constraints.quoteStep).eq(quotePerLevel) ||
      quotePerLevel.lt(constraints.minQuote)
    ) {
      throw new Error(
        "Saved grid quote allocation does not satisfy the current pair constraints. Use --reset to replace it safely.",
      );
    }

    const prices = state.levels.map((level) => new Decimal(level.price));
    for (let index = 0; index < prices.length; index++) {
      const price = prices[index];
      if (
        !price.gt(0) ||
        !floorToStep(price, constraints.quoteStep).eq(price) ||
        (index > 0 && !price.gt(prices[index - 1]))
      ) {
        throw new Error(
          "Saved grid prices do not satisfy the current pair constraints. Use --reset to replace it safely.",
        );
      }
    }

    const sourceLevelCount = state.config.splitInvestment
      ? state.levels.length - 1
      : state.levels.length / 2;
    const stopLoss = state.config.stopLoss
      ? new Decimal(state.config.stopLoss)
      : null;
    for (let index = 0; index < sourceLevelCount; index++) {
      normalizeBaseOrderSize(
        quotePerLevel.div(prices[index]),
        constraints,
        stopLoss ?? prices[index + 1],
      );
    }

    let heldBase = new Decimal(0);
    for (const level of state.levels) {
      const sellPrice =
        stopLoss ?? prices[Math.min(level.index + 1, prices.length - 1)];
      for (const position of level.positions) {
        const positionBase = new Decimal(position.baseHeld);
        heldBase = heldBase.plus(positionBase);
        if (position.sellOrderId || position.sellClientOrderId) {
          normalizeBaseOrderSize(
            position.sellBaseSize
              ? new Decimal(position.sellBaseSize)
              : positionBase,
            constraints,
            sellPrice,
          );
        }
      }
    }
    if (stopLoss) {
      const liquidationBase = floorToStep(heldBase, constraints.baseStep);
      if (liquidationBase.gt(0)) {
        normalizeBaseOrderSize(liquidationBase, constraints, stopLoss);
      }
    }
  }

  private _getQuoteStep(): Decimal {
    if (this._state?.quotePrecision) {
      return new Decimal(this._state.quotePrecision);
    }
    return this._pairInfo
      ? new Decimal(this._pairInfo.quote_step)
      : new Decimal("0.01");
  }

  private _getBaseStep(): Decimal {
    if (this._state?.basePrecision) {
      return new Decimal(this._state.basePrecision);
    }
    return this._pairInfo
      ? new Decimal(this._pairInfo.base_step)
      : new Decimal("0.00001");
  }

  private async _getCurrentPrice(): Promise<Decimal> {
    if (!this._priceSource) {
      throw new Error("price source not initialized");
    }
    if (this._priceSource.peek) {
      return this._priceSource.peek();
    }
    const t = await this._priceSource.next();
    if (!t) {
      throw new Error("price source exhausted");
    }
    return t.price;
  }

  private async _checkBalance(quoteCurrency: string): Promise<Decimal | null> {
    try {
      const balances = await this._client!.getBalances();
      const entry = balances.find((b) => b.currency === quoteCurrency);
      return entry ? new Decimal(entry.available) : new Decimal(0);
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._log(
        chalk.yellow(
          `  Warning: Could not check balance: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return null;
    }
  }

  private _checkBoundary(currentPrice: Decimal): void {
    const state = this._state;
    if (!state) return;

    const levels = state.levels;
    const lower = new Decimal(levels[0].price);
    const upper = new Decimal(levels[levels.length - 1].price);
    const cs = this._cs;

    if (this._config.trailingUp) {
      const trailUpPrice = trailUpTriggerPrice(levels);
      if (trailUpPrice !== null && currentPrice.gte(trailUpPrice)) {
        this._shouldRebuildUp = true;
        this._boundaryAlerted = false;
        return;
      }
    }

    if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
      const below = currentPrice.lt(lower);
      const direction = below ? "below" : "above";
      const boundary = below ? lower : upper;
      this._warnings.push(
        `Price ${direction} grid range (${fmtPrice(boundary, cs)})`,
      );
      if (!this._boundaryAlerted) {
        this._boundaryAlerted = true;
        const risk = below
          ? "Buy orders may keep filling without matching sells — accumulating inventory."
          : "Price is above all grid levels — bot is idle with no active orders.";
        this._notify(
          `Grid Bot ${state.pair}: Price exited grid range (${direction} ${fmtPrice(boundary, cs)}). ` +
            `Current: ${fmtPrice(currentPrice, cs)}. ${risk}`,
        );
      }
    } else {
      this._boundaryAlerted = false;
    }
  }

  private async _rebuildGridUp(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client;
    const cs = this._cs;
    if (this._hasUnresolvedPlacementIntents()) {
      this._warnings.push(
        "Trailing up deferred: unresolved order placement present, will retry next tick",
      );
      return;
    }
    const N = state.levels.length;

    // Save per-level buy order counts before clearing (used for split mode)
    const savedCounts = state.levels.map((l) => l.buyOrderIds.length);

    // Compute ratio from existing level prices (before shift)
    const lower = new Decimal(state.levels[0].price);
    const upper = new Decimal(state.levels[N - 1].price);
    const ratio = upper.div(lower).pow(new Decimal(1).div(N - 1));
    const quoteStep = this._getQuoteStep();

    // Shift amount:
    //   split:    find smallest k such that new upper (old_upper × ratio^k) > currentPrice
    //             buy counts come from savedCounts; intermediate empty levels are acceptable
    //   no-split: find smallest k such that levels[N/2] (first sell-destination) > currentPrice
    //             this guarantees exactly N/2 buy levels below price after the shift
    let k: number;
    if (this._config.splitInvestment) {
      k = 1;
      while (upper.times(ratio.pow(k)).lte(currentPrice)) {
        k++;
      }
    } else {
      const sellBoundaryPrice = new Decimal(
        state.levels[Math.floor(N / 2)].price,
      );
      k = Math.floor(N / 2) + 1;
      while (sellBoundaryPrice.times(ratio.pow(k)).lte(currentPrice)) {
        k++;
      }
    }
    const ratioK = ratio.pow(k);
    const candidatePrices = state.levels.map((level) =>
      roundToStep(new Decimal(level.price).times(ratioK), quoteStep),
    );
    const constraints = this._getOrderConstraints();
    const quotePerLevel = new Decimal(state.quotePerLevel);

    for (let i = 0; i < candidatePrices.length; i++) {
      const price = candidatePrices[i];
      if (!price.gt(0) || (i > 0 && !price.gt(candidatePrices[i - 1]))) {
        throw new Error(
          "Trailing grid does not produce unique prices at the pair precision.",
        );
      }
      const count = this._config.splitInvestment ? savedCounts[i] : 1;
      if (price.lt(currentPrice) && count > 0) {
        const executionPrice = this._config.stopLoss
          ? new Decimal(this._config.stopLoss)
          : candidatePrices[Math.min(i + 1, candidatePrices.length - 1)];
        normalizeBaseOrderSize(
          quotePerLevel.div(price),
          constraints,
          executionPrice,
        );
      }
    }

    if (!this._config.dryRun && client) {
      const cancelErrors: string[] = [];
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        for (const buyOrderId of [...level.buyOrderIds]) {
          cancels.push(
            this._cancelOrderWithoutFill(buyOrderId)
              .then(() => {
                this._removeBuyOrder(level, buyOrderId);
              })
              .catch((err) => {
                rethrowIfInsecureKey(err);
                cancelErrors.push(
                  err instanceof Error ? err.message : String(err),
                );
              }),
          );
        }
        for (const pos of level.positions) {
          const sellOrderId = pos.sellOrderId;
          if (sellOrderId) {
            cancels.push(
              this._cancelOrderWithoutFill(sellOrderId)
                .then(() => {
                  pos.sellOrderId = null;
                  pos.sellBaseSize = undefined;
                  pos.sellClientOrderId = undefined;
                })
                .catch((err) => {
                  rethrowIfInsecureKey(err);
                  cancelErrors.push(
                    err instanceof Error ? err.message : String(err),
                  );
                }),
            );
          }
        }
      }
      await Promise.all(cancels);
      if (cancelErrors.length > 0) {
        this._saveGridState(state);
        throw new Error(
          `Unable to rebuild grid because ${cancelErrors.length} order cancellation${cancelErrors.length === 1 ? "" : "s"} failed: ${cancelErrors[0]}`,
        );
      }
    }

    for (const level of state.levels) {
      level.buyOrderIds = [];
      level.buyOrderQuoteSizes = {};
      level.positions = [];
    }

    for (let i = 0; i < N; i++) {
      state.levels[i].price = candidatePrices[i].toString();
    }

    state.gridPrice = currentPrice.toString();

    const rebuilds: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      const level = state.levels[i];
      if (!new Decimal(level.price).lt(currentPrice)) continue;

      // split: restore savedCounts per level; no-split: exactly 1 buy per level below price
      const count = this._config.splitInvestment ? savedCounts[i] : 1;
      level.expectedBuys = count;

      for (let j = 0; j < count; j++) {
        rebuilds.push(
          this._placeBuyOrder(level, quotePerLevel).catch((err) => {
            rethrowIfInsecureKey(err);
            this._warnings.push(
              `Rebuild buy @${level.price}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        );
      }
    }
    await Promise.all(rebuilds);

    state.shiftCount = (state.shiftCount ?? 0) + 1;
    this._saveGridState(state);

    this._notify(
      `Grid Bot ${state.pair}: trailing up — grid rebuilt around ${fmtPrice(currentPrice, cs)} ` +
        `(shift #${state.shiftCount})`,
    );
  }

  private async _triggerStopLoss(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client;
    const cs = this._cs;

    // 1. Cancel all open orders to free reserved funds
    let cancellationsSucceeded = true;
    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        for (const buyOrderId of [...level.buyOrderIds]) {
          cancels.push(
            this._cancelOrderWithoutFill(buyOrderId)
              .then(() => {
                this._removeBuyOrder(level, buyOrderId);
              })
              .catch((err) => {
                rethrowIfInsecureKey(err);
                cancellationsSucceeded = false;
                this._warnings.push(
                  `Stop-loss cancellation failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }),
          );
        }
        for (const pos of level.positions) {
          const sellOrderId = pos.sellOrderId;
          if (sellOrderId) {
            cancels.push(
              this._cancelOrderWithoutFill(sellOrderId)
                .then(() => {
                  pos.sellOrderId = null;
                  pos.sellBaseSize = undefined;
                  pos.sellClientOrderId = undefined;
                })
                .catch((err) => {
                  rethrowIfInsecureKey(err);
                  cancellationsSucceeded = false;
                  this._warnings.push(
                    `Stop-loss cancellation failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }),
            );
          }
        }
      }
      await Promise.all(cancels);
    } else if (this._config.dryRun) {
      for (const level of state.levels) {
        level.buyOrderIds = [];
        level.buyOrderQuoteSizes = {};
        for (const pos of level.positions) {
          pos.sellOrderId = null;
          pos.sellBaseSize = undefined;
          pos.sellClientOrderId = undefined;
        }
      }
    }

    // 2. Sell all accumulated base asset via market order
    const baseStep = this._getBaseStep();
    const allPositions = state.levels.flatMap((l) => l.positions);
    const rawTotalBase = allPositions
      .filter((p) => new Decimal(p.baseHeld).gt(0))
      .reduce((sum, p) => sum.plus(p.baseHeld), new Decimal(0));
    let totalBase = floorToStep(rawTotalBase, baseStep);
    let liquidationOrderIsValid = true;
    if (cancellationsSucceeded && rawTotalBase.gt(0)) {
      try {
        totalBase = normalizeBaseOrderSize(
          totalBase,
          this._getOrderConstraints(),
          currentPrice,
        );
      } catch (err) {
        liquidationOrderIsValid = false;
        this._warnings.push(
          `Stop-loss position cannot be liquidated automatically: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    let liquidationSucceeded = cancellationsSucceeded && rawTotalBase.isZero();

    if (cancellationsSucceeded && liquidationOrderIsValid && totalBase.gt(0)) {
      if (!this._config.dryRun && client) {
        try {
          state.stopLossClientOrderId ??= randomUUID();
          this._saveGridState(state);
          const resp = await this._rateLimiter.place(() =>
            client.placeOrder({
              symbol: this._config.pair,
              side: "sell",
              clientOrderId: state.stopLossClientOrderId,
              market: { baseSize: totalBase.toString() },
            }),
          );
          const filled = await this._awaitOrderFill(resp.data.venue_order_id);
          if (this._hasFilledQuantity(filled)) {
            const {
              baseDelivered,
              quoteProceeds: revenue,
              feeQuote,
            } = this._sellEconomics(filled, currentPrice);
            const filledBase = Decimal.min(baseDelivered, totalBase);
            const costBasis = this._consumeHeldBase(filledBase);
            const pnl = revenue.minus(costBasis);
            this._addFee(feeQuote);
            state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
              .plus(pnl)
              .toString();
            state.stats.totalSells++;
            this._logTrade(
              "sell",
              currentPrice.toString(),
              filledBase.toString(),
              "stop-loss",
              pnl.toFixed(2),
              feeQuote.toString(),
            );
            liquidationSucceeded = filledBase.eq(totalBase);
          }
          state.stopLossClientOrderId = liquidationSucceeded
            ? undefined
            : randomUUID();
          this._saveGridState(state);
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Stop-loss market sell failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (this._config.dryRun) {
        // Simulate the market sell in dry-run mode
        const costBasis = this._consumeHeldBase(totalBase);
        const grossRevenue = totalBase.times(currentPrice);
        const feeQuote = grossRevenue.times(TAKER_FEE_RATE);
        const revenue = grossRevenue
          .minus(feeQuote)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const pnl = revenue.minus(costBasis);
        this._addFee(feeQuote);
        state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
          .plus(pnl)
          .toString();
        state.stats.totalSells++;
        this._logTrade(
          "sell",
          currentPrice.toString(),
          totalBase.toString(),
          "stop-loss",
          pnl.toFixed(2),
        );
        liquidationSucceeded = true;
      }
    }

    this._notify(
      `Grid Bot ${state.pair}: STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)}. ` +
        `${liquidationSucceeded ? `Sold ${totalBase} base` : `Failed to sell ${totalBase} base`}. ` +
        `Realized P&L: ${fmtSignedPnl(new Decimal(state.stats.realizedPnl), cs)}`,
    );

    this._lifecycle = "stopped";
    this._currentPrice = currentPrice;
    if (this._statusReporter) {
      await this._statusReporter.flush(this._renderStatusCard());
      state.statusMessages = this._statusReporter.snapshot();
    }
    this._saveGridState(state);
    this.stop();
  }

  private async _awaitOrderFill(
    orderId: string,
    timeoutMs = 30_000,
  ): Promise<OrderDetails> {
    const client = this._client!;
    const start = Date.now();
    const pollIntervalMs = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await this._rateLimiter.query(() =>
          client.getOrder(orderId),
        );
        const order = resp.data;

        if (
          FILLED_STATUSES.has(order.status) ||
          DEAD_STATUSES.has(order.status)
        ) {
          return order;
        }
        if (
          order.status === PARTIALLY_FILLED_STATUS &&
          !(await this._getActiveOrderIds()).has(orderId)
        ) {
          return order;
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Market buy order did not fill within ${timeoutMs / 1000}s: ${orderId}`,
    );
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
      const price = filledQty.gt(0)
        ? filledAmount.div(filledQty)
        : fallbackPrice;
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

  private _feeSide(order: OrderDetails): "base" | "quote" | null {
    const fee = order.total_fee ? new Decimal(order.total_fee) : new Decimal(0);
    if (!fee.gt(0)) return null;
    const [baseCurrency, quoteCurrency] = this._config.pair.split("-");
    if (order.fee_currency === baseCurrency) return "base";
    if (order.fee_currency === quoteCurrency) return "quote";
    return null;
  }

  private _buyEconomics(
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): { baseReceived: Decimal; quoteCost: Decimal; feeQuote: Decimal } {
    const feeQuote = this._feeQuote(order, fallbackPrice);
    const filledAmount = this._filledAmount(order, fallbackPrice);
    if (this._feeSide(order) === "base") {
      return {
        baseReceived: this._netBase(order),
        quoteCost: filledAmount,
        feeQuote,
      };
    }
    return {
      baseReceived: new Decimal(order.filled_quantity),
      quoteCost: filledAmount.plus(feeQuote),
      feeQuote,
    };
  }

  private _sellEconomics(
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): { baseDelivered: Decimal; quoteProceeds: Decimal; feeQuote: Decimal } {
    const feeQuote = this._feeQuote(order, fallbackPrice);
    const filledAmount = this._filledAmount(order, fallbackPrice);
    const filledQty = new Decimal(order.filled_quantity);
    if (this._feeSide(order) === "base") {
      const fee = new Decimal(order.total_fee!);
      return {
        baseDelivered: filledQty.plus(fee),
        quoteProceeds: filledAmount,
        feeQuote,
      };
    }
    return {
      baseDelivered: filledQty,
      quoteProceeds: filledAmount.minus(feeQuote),
      feeQuote,
    };
  }

  private _hasFilledQuantity(order: OrderDetails): boolean {
    return new Decimal(order.filled_quantity).gt(0);
  }

  private _removeBuyOrder(level: GridLevelState, orderId: string): void {
    level.buyOrderIds = level.buyOrderIds.filter((id) => id !== orderId);
    if (level.buyOrderQuoteSizes) {
      delete level.buyOrderQuoteSizes[orderId];
    }
  }

  private _hasUnresolvedPlacementIntents(): boolean {
    if (!this._state) return false;
    return (
      (!!this._state.splitClientOrderId && !this._state.splitOrderId) ||
      !!this._state.stopLossClientOrderId ||
      this._state.levels.some(
        (level) =>
          (level.pendingBuyClientOrderIds?.length ?? 0) > 0 ||
          level.positions.some(
            (position) => !!position.sellClientOrderId && !position.sellOrderId,
          ),
      )
    );
  }

  private _hasTrackedInventory(state: GridState): boolean {
    return (
      new Decimal(state.splitAccumulatedBase ?? 0).gt(0) ||
      state.levels.some((level) =>
        level.positions.some((position) =>
          new Decimal(position.baseHeld).gt(0),
        ),
      )
    );
  }

  private _settleTerminalBuyFill(
    level: GridLevelState,
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): { position: GridLevelPosition | null; remainingQuote: Decimal } {
    const submittedQuote = new Decimal(
      level.buyOrderQuoteSizes?.[order.id] ?? this._state!.quotePerLevel,
    );
    const filledAmount = this._filledAmount(order, fallbackPrice);
    const {
      baseReceived: netBase,
      quoteCost,
      feeQuote,
    } = this._buyEconomics(order, fallbackPrice);
    const remainingQuote = floorToStep(
      Decimal.max(new Decimal(0), submittedQuote.minus(filledAmount)),
      this._getQuoteStep(),
    );
    this._removeBuyOrder(level, order.id);

    let position: GridLevelPosition | null = null;
    if (netBase.gt(0)) {
      position = {
        id: order.id,
        baseHeld: netBase.toString(),
        fillCost: quoteCost.toString(),
        sellOrderId: null,
      };
      level.positions.push(position);
      this._state!.stats.totalBuys++;
      this._addFee(feeQuote);
      this._logTrade(
        "buy",
        fallbackPrice.toString(),
        netBase.toString(),
        order.id,
        undefined,
        feeQuote.toString(),
      );
    }
    this._saveGridState(this._state!);
    return { position, remainingQuote };
  }

  private async _placeRemainingBuy(
    level: GridLevelState,
    quoteSize: Decimal,
  ): Promise<void> {
    const constraints = this._getOrderConstraints();
    if (quoteSize.lt(constraints.minQuote)) return;
    const sellLevel = this._state!.levels[level.index + 1];
    normalizeBaseOrderSize(
      quoteSize.div(level.price),
      constraints,
      this._config.stopLoss
        ? new Decimal(this._config.stopLoss)
        : sellLevel
          ? new Decimal(sellLevel.price)
          : undefined,
    );
    await this._placeBuyOrder(level, quoteSize);
  }

  private async _processTerminalBuy(
    level: GridLevelState,
    order: OrderDetails,
    notify: boolean,
  ): Promise<boolean> {
    if (!this._hasFilledQuantity(order)) {
      this._removeBuyOrder(level, order.id);
      this._saveGridState(this._state!);
      return false;
    }

    const levelPrice = new Decimal(level.price);
    const settlement = this._settleTerminalBuyFill(level, order, levelPrice);
    if (settlement.position) {
      const sellLevel = this._state!.levels[level.index + 1];
      if (sellLevel) {
        await this._placeSellOnLevel(sellLevel, settlement.position);
      }
      if (notify) {
        const base = this._config.pair.split("-")[0] ?? "";
        const feeQuote = this._feeQuote(order, levelPrice);
        const feeStr = feeQuote.gt(0)
          ? ` | fee ${this._cs}${feeQuote.toFixed(2)}`
          : "";
        this._notify(
          `Grid Bot ${this._config.pair}: BUY filled @ ${this._cs}${level.price} | ${settlement.position.baseHeld} ${base}${feeStr}`,
        );
      }
    }
    if (settlement.remainingQuote.gt(0)) {
      try {
        await this._placeRemainingBuy(level, settlement.remainingQuote);
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._warnings.push(
          `Partial buy remainder @${level.price}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  private async _processTerminalSell(
    level: GridLevelState,
    sellLevel: GridLevelState,
    position: GridLevelPosition,
    order: OrderDetails,
    notify: boolean,
  ): Promise<PositionSettlement> {
    const sellPrice = new Decimal(sellLevel.price);
    const settlement = this._settlePositionFill(
      level,
      position,
      order,
      sellPrice,
    );
    this._state!.stats.totalSells++;
    this._addFee(settlement.feeQuote);
    this._state!.stats.realizedPnl = new Decimal(this._state!.stats.realizedPnl)
      .plus(settlement.profit)
      .toString();
    this._logTrade(
      "sell",
      sellPrice.toString(),
      settlement.quantity.toString(),
      order.id,
      settlement.profit.toFixed(2),
      settlement.feeQuote.toString(),
    );
    this._saveGridState(this._state!);

    if (notify) {
      const base = this._config.pair.split("-")[0] ?? "";
      const feeStr = settlement.feeQuote.gt(0)
        ? ` | fee ${this._cs}${settlement.feeQuote.toFixed(2)}`
        : "";
      this._notify(
        `Grid Bot ${this._config.pair}: SELL filled @ ${this._cs}${sellPrice} | ` +
          `${settlement.quantity} ${base} | profit ${fmtSignedPnl(settlement.profit, this._cs)}${feeStr} | ` +
          `total P&L: ${fmtSignedPnl(new Decimal(this._state!.stats.realizedPnl), this._cs)}`,
      );
    }

    if (settlement.remainingBase.gt(0)) {
      await this._placeSellOnLevel(sellLevel, position);
    }

    const rebuyQuote = FILLED_STATUSES.has(order.status)
      ? new Decimal(this._state!.quotePerLevel)
      : floorToStep(settlement.costBasis, this._getQuoteStep());
    if (rebuyQuote.gt(0)) {
      try {
        await this._placeRemainingBuy(level, rebuyQuote);
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._warnings.push(
          `Partial sell re-buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return settlement;
  }

  private _settlePositionFill(
    level: GridLevelState,
    position: GridLevelPosition,
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): PositionSettlement {
    const heldBase = new Decimal(position.baseHeld);
    const sell = this._sellEconomics(order, fallbackPrice);
    const orderFilledBase = sell.baseDelivered;
    const submittedBase = position.sellBaseSize
      ? new Decimal(position.sellBaseSize)
      : orderFilledBase;
    const settledBase = Decimal.min(heldBase, orderFilledBase, submittedBase);
    if (!settledBase.gt(0) || !orderFilledBase.gt(0)) {
      throw new Error(`Sell order ${order.id} has no filled base quantity.`);
    }

    const fillRatio = settledBase.div(orderFilledBase);
    const proceeds = sell.quoteProceeds.times(fillRatio);
    const feeQuote = sell.feeQuote.times(fillRatio);
    const fullCostBasis =
      position.fillCost && position.fillCost !== "0"
        ? new Decimal(position.fillCost)
        : new Decimal(this._state!.quotePerLevel);
    const settledCostBasis = fullCostBasis.times(settledBase).div(heldBase);
    const remainingBase = heldBase.minus(settledBase);
    const remainingCostBasis = fullCostBasis.minus(settledCostBasis);

    if (remainingBase.gt(0)) {
      position.baseHeld = remainingBase.toString();
      position.fillCost = remainingCostBasis.toString();
      position.sellOrderId = null;
      position.sellBaseSize = undefined;
      position.sellClientOrderId = undefined;
    } else {
      level.positions = level.positions.filter(
        (candidate) => candidate !== position,
      );
    }

    return {
      quantity: settledBase,
      feeQuote,
      profit: proceeds.minus(settledCostBasis),
      costBasis: settledCostBasis,
      remainingBase,
    };
  }

  private _consumeHeldBase(quantity: Decimal): Decimal {
    let remaining = quantity;
    let consumedCost = new Decimal(0);

    for (const level of this._state!.levels) {
      for (const position of [...level.positions]) {
        if (!remaining.gt(0)) {
          return consumedCost;
        }
        const heldBase = new Decimal(position.baseHeld);
        if (!heldBase.gt(0)) continue;

        const consumedBase = Decimal.min(heldBase, remaining);
        const fullCostBasis =
          position.fillCost && position.fillCost !== "0"
            ? new Decimal(position.fillCost)
            : new Decimal(this._state!.quotePerLevel);
        const positionCost = fullCostBasis.times(consumedBase).div(heldBase);
        const residualBase = heldBase.minus(consumedBase);
        consumedCost = consumedCost.plus(positionCost);
        remaining = remaining.minus(consumedBase);

        if (residualBase.gt(0)) {
          position.baseHeld = residualBase.toString();
          position.fillCost = fullCostBasis.minus(positionCost).toString();
          position.sellOrderId = null;
          position.sellBaseSize = undefined;
          position.sellClientOrderId = undefined;
        } else {
          level.positions = level.positions.filter(
            (candidate) => candidate !== position,
          );
        }
      }
    }

    return consumedCost;
  }

  private _addFee(fee: Decimal): void {
    if (!this._state || fee.lte(0)) return;
    const cur = new Decimal(this._state.stats.totalFees ?? "0");
    this._state.stats.totalFees = cur.plus(fee).toString();
  }

  private async _executeSplitMarketBuy(
    totalQuote: Decimal,
  ): Promise<{ base: Decimal; cost: Decimal; fee: Decimal }> {
    const state = this._state!;
    const constraints = this._getOrderConstraints();
    state.splitRemainingQuote ??= totalQuote.toString();
    state.splitAccumulatedBase ??= "0";
    state.splitAccumulatedAmount ??= "0";
    state.splitAccumulatedFee ??= "0";
    if (state.splitOrderId) {
      state.splitOrderQuoteSize ??= state.splitRemainingQuote;
    }

    while (new Decimal(state.splitRemainingQuote).gte(constraints.minQuote)) {
      if (!state.splitOrderId) {
        state.splitClientOrderId ??= randomUUID();
        state.splitOrderQuoteSize ??= state.splitRemainingQuote;
        this._saveGridState(state);
        const orderResponse = await this._rateLimiter.place(() =>
          this._client!.placeOrder({
            symbol: this._config.pair,
            side: "buy",
            clientOrderId: state.splitClientOrderId,
            market: { quoteSize: state.splitOrderQuoteSize },
          }),
        );
        state.splitOrderId = orderResponse.data.venue_order_id;
        this._saveGridState(state);
      }

      const terminalOrder = await this._awaitOrderFill(state.splitOrderId);
      if (!this._hasFilledQuantity(terminalOrder)) {
        const terminalStatus = terminalOrder.status;
        state.splitOrderId = undefined;
        state.splitClientOrderId = undefined;
        state.splitOrderQuoteSize = undefined;
        this._saveGridState(state);
        throw new Error(
          `Split market buy ${terminalStatus} without a fill. Retry to place a new idempotent order.`,
        );
      }

      const fallbackPrice = new Decimal(state.gridPrice);
      const {
        baseReceived: filledBase,
        quoteCost,
        feeQuote,
      } = this._buyEconomics(terminalOrder, fallbackPrice);
      const filledAmount = this._filledAmount(terminalOrder, fallbackPrice);
      const submittedQuote: Decimal = new Decimal(state.splitOrderQuoteSize!);
      state.splitAccumulatedBase = new Decimal(state.splitAccumulatedBase)
        .plus(filledBase)
        .toString();
      state.splitAccumulatedAmount = new Decimal(state.splitAccumulatedAmount)
        .plus(quoteCost)
        .toString();
      state.splitAccumulatedFee = new Decimal(state.splitAccumulatedFee)
        .plus(feeQuote)
        .toString();
      state.splitRemainingQuote = floorToStep(
        Decimal.max(new Decimal(0), submittedQuote.minus(filledAmount)),
        constraints.quoteStep,
      ).toString();
      state.splitOrderId = undefined;
      state.splitClientOrderId = undefined;
      state.splitOrderQuoteSize = undefined;
      this._saveGridState(state);
    }

    return {
      base: new Decimal(state.splitAccumulatedBase),
      cost: new Decimal(state.splitAccumulatedAmount),
      fee: new Decimal(state.splitAccumulatedFee),
    };
  }

  private _clearSplitExecutionState(): void {
    const state = this._state!;
    state.splitOrderId = undefined;
    state.splitClientOrderId = undefined;
    state.splitOrderQuoteSize = undefined;
    state.splitRemainingQuote = undefined;
    state.splitAccumulatedBase = undefined;
    state.splitAccumulatedAmount = undefined;
    state.splitAccumulatedFee = undefined;
    state.splitAccountingApplied = undefined;
  }

  // --------------- initialization ---------------

  private async _initNewGrid(): Promise<void> {
    const config = this._config;

    this._log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getCurrentPrice();
    this._log(chalk.dim(`  Current price: ${currentPrice}`));

    const quoteCurrency = config.pair.split("-")[1] ?? "";
    const investment = new Decimal(config.investment);
    const available = config.dryRun
      ? null
      : await this._checkBalance(quoteCurrency);

    const rangePct = new Decimal(config.rangePct);
    const constraints = this._getOrderConstraints();
    const quoteStep = constraints.quoteStep;
    const baseStep = constraints.baseStep;
    const plan = createGridPlan({
      startPrice: currentPrice,
      totalLevels: config.levels,
      rangePct,
      investment,
      split: config.splitInvestment,
      stopLoss: config.stopLoss ? new Decimal(config.stopLoss) : undefined,
      constraints,
    });
    const levels: GridLevelState[] = plan.levels.map((level) => ({
      index: level.index,
      price: level.price.toString(),
      buyOrderIds: [],
      positions: [],
    }));
    const sellLevelIndices = new Set(plan.sellLevelIndices);
    const totalCapitalLevels =
      plan.buyLevelIndices.length +
      (config.splitInvestment ? plan.sellLevelIndices.length : 0);
    const quotePerLevel = plan.quotePerLevel;

    if (available !== null && available.lt(investment)) {
      const maxInvestment = floorToStep(available, quoteStep);
      throw new Error(
        `Available ${quoteCurrency} balance (${available.toFixed(2)}) is less than ` +
          `the configured investment (${investment.toFixed(2)}). ` +
          `With ${totalCapitalLevels} capital level${totalCapitalLevels === 1 ? "" : "s"}, ` +
          `each level requires ${quotePerLevel.toFixed(2)} ${quoteCurrency}. ` +
          `Use --investment ${maxInvestment.toFixed(2)} to invest your full available balance, ` +
          `or deposit funds and retry.`,
      );
    }

    const strategyId = randomUUID().slice(0, 8);
    this._state = {
      id: strategyId,
      pair: config.pair,
      version: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {
        levels: config.levels,
        rangePct: config.rangePct,
        investment: config.investment,
        splitInvestment: config.splitInvestment,
        intervalSec: config.intervalSec,
        dryRun: config.dryRun,
        trailingUp: config.trailingUp,
        stopLoss: config.stopLoss,
      },
      splitExecuted: false,
      initializing: true,
      shiftCount: 0,
      gridPrice: currentPrice.toString(),
      quotePrecision: quoteStep.toString(),
      basePrecision: baseStep.toString(),
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
    this._saveGridState(this._state);

    let splitBaseAcquired: Decimal | null = null;
    let splitQuoteCost: Decimal | null = null;
    let splitFeeQuote = new Decimal(0);
    if (config.splitInvestment && !config.dryRun) {
      const marketBuyQuote = quotePerLevel.times(sellLevelIndices.size);
      this._log(
        chalk.dim(
          `  Placing market buy for ${marketBuyQuote} ${quoteCurrency}...`,
        ),
      );
      this._log(
        chalk.dim(
          `  Market buy placed: ${marketBuyQuote} ${quoteCurrency}. Waiting for fill...`,
        ),
      );
      const splitExecution = await this._executeSplitMarketBuy(marketBuyQuote);
      splitBaseAcquired = splitExecution.base;
      splitQuoteCost = splitExecution.cost;
      splitFeeQuote = splitExecution.fee;
      this._state.splitExecuted = true;
      this._saveGridState(this._state);
      const baseCurrency = config.pair.split("-")[0] ?? "";
      this._log(
        chalk.dim(
          `  Market buy filled: ${splitBaseAcquired} ${baseCurrency}` +
            (splitFeeQuote.gt(0)
              ? ` (fee ${splitFeeQuote.toFixed(2)} ${quoteCurrency})`
              : ""),
        ),
      );
    }

    if (
      this._state.splitExecuted &&
      splitBaseAcquired &&
      !this._state.splitAccountingApplied
    ) {
      this._addFee(splitFeeQuote);
      this._logTrade(
        "buy",
        currentPrice.toString(),
        splitBaseAcquired.toString(),
        "split-init",
      );
      this._state.splitAccountingApplied = true;
      this._saveGridState(this._state);
    } else if (
      config.splitInvestment &&
      config.dryRun &&
      sellLevelIndices.size > 0
    ) {
      const dryRunQuote = quotePerLevel.times(sellLevelIndices.size);
      const dryRunBase = dryRunQuote
        .div(currentPrice)
        .times(new Decimal(1).minus(TAKER_FEE_RATE));
      this._addFee(dryRunQuote.times(TAKER_FEE_RATE));
      this._logTrade(
        "buy",
        currentPrice.toString(),
        floorToStep(dryRunBase, baseStep).toString(),
        "split-init",
      );
    }

    // --- Place initial buy orders ---
    const buyLevels = plan.buyLevelIndices.map((index) => levels[index]);
    let buysPlaced = 0;
    const errors: string[] = [];
    this._log(chalk.dim(`  Placing ${buyLevels.length} initial buy orders...`));
    await Promise.all(
      buyLevels.map(async (level) => {
        try {
          await this._placeBuyOrder(level, quotePerLevel);
          buysPlaced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`buy @${level.price}: ${msg}`);
        }
      }),
    );

    if (buysPlaced === 0 && buyLevels.length > 0) {
      const detail = errors.length > 0 ? `\n  First error: ${errors[0]}` : "";
      throw new Error(
        `Failed to place any initial buy orders (0/${buyLevels.length}).${detail}`,
      );
    }

    this._log(
      chalk.dim(
        `  Buy orders placed: ${buysPlaced}/${buyLevels.length}` +
          (errors.length > 0 ? chalk.yellow(` (${errors.length} failed)`) : ""),
      ),
    );
    if (errors.length > 0) {
      this._saveGridState(this._state);
      throw new Error(
        `Failed to place all initial buy orders (${buysPlaced}/${buyLevels.length}): ${errors[0]}`,
      );
    }

    // --- Place initial sell orders for split mode ---
    let sellsPlaced = 0;
    if (config.splitInvestment && sellLevelIndices.size > 0) {
      const sortedSellLevelIndices = [...sellLevelIndices].sort(
        (a, b) => a - b,
      );
      const totalBase =
        splitBaseAcquired ??
        floorToStep(
          quotePerLevel
            .times(sellLevelIndices.size)
            .div(currentPrice)
            .times(new Decimal(1).minus(TAKER_FEE_RATE)),
          baseStep,
        );
      const baseByLevel = allocateBaseOrderSizes(
        totalBase,
        sortedSellLevelIndices.length,
        constraints,
        sortedSellLevelIndices.map((index) =>
          config.stopLoss
            ? new Decimal(config.stopLoss)
            : new Decimal(levels[index].price),
        ),
      );
      const totalSplitCost = splitQuoteCost;
      const allocatedBase = baseByLevel.reduce(
        (sum, baseAmount) => sum.plus(baseAmount),
        new Decimal(0),
      );
      if (allocatedBase.gt(0)) {
        this._log(
          chalk.dim(
            `  Placing ${sellLevelIndices.size} initial sell orders...`,
          ),
        );

        await Promise.all(
          sortedSellLevelIndices.map(async (sellIdx, allocationIndex) => {
            const sellLevel = levels[sellIdx];
            const buyLevel = levels[sellIdx - 1];

            if (buyLevel) {
              const baseForLevel = baseByLevel[allocationIndex];
              const costForLevel = totalSplitCost
                ? totalSplitCost.times(baseForLevel).div(allocatedBase)
                : quotePerLevel;
              const pos: GridLevelPosition = {
                id: `split-${sellIdx}`,
                baseHeld: baseForLevel.toString(),
                fillCost: costForLevel.toString(),
                sellOrderId: null,
              };
              buyLevel.positions.push(pos);
              await this._placeSellOnLevel(sellLevel, pos);
              if (pos.sellOrderId) {
                sellsPlaced++;
                this._saveGridState(this._state!);
              } else if (!pos.sellClientOrderId) {
                buyLevel.positions.pop();
              }
            }
          }),
        );

        this._log(
          chalk.dim(
            `  Sell orders placed: ${sellsPlaced}/${sellLevelIndices.size}`,
          ),
        );
        if (sellsPlaced !== sellLevelIndices.size) {
          this._saveGridState(this._state);
          throw new Error(
            `Failed to place all initial sell orders (${sellsPlaced}/${sellLevelIndices.size}).`,
          );
        }
      }
    }

    this._state.initializing = false;
    this._clearSplitExecutionState();
    this._saveGridState(this._state);

    if (errors.length > 0) {
      this._warnings = errors.slice(0, 3).map((e) => `Order failed: ${e}`);
    }
    this._log(chalk.dim("  Grid initialized and state saved.\n"));
  }

  // --------------- reconciliation ---------------

  private async _reconcileAndInit(savedState: GridState): Promise<void> {
    const config = this._config;
    const client = this._client!;

    this._log(chalk.dim("\n  Saved state found. Resuming grid..."));

    const constraints = this._getOrderConstraints();
    this._validateSavedStateOrderConstraints(savedState, constraints);

    // Phase 1: Adopt saved state as-is
    this._state = savedState;

    // Update mutable config fields (everything else validated in run())
    this._state.config.intervalSec = config.intervalSec;

    const quoteStep = constraints.quoteStep;
    const baseStep = constraints.baseStep;
    this._state.quotePrecision = quoteStep.toString();
    this._state.basePrecision = baseStep.toString();

    if (this._state.stopLossClientOrderId) {
      await this._triggerStopLoss(await this._getCurrentPrice());
      return;
    }

    // Phase 2: Verify each saved order against the exchange
    let buysFilled = 0;
    let sellsFilled = 0;
    let ordersKept = 0;
    let ordersDead = 0;
    const settledBuyLevelIndices = new Set<number>();
    const settledSellSourceIndices = new Set<number>();
    let activeOrderIds: Set<string> | null = null;
    const isTerminalPartialFill = async (order: OrderDetails) => {
      if (order.status !== PARTIALLY_FILLED_STATUS) return false;
      activeOrderIds ??= await this._getActiveOrderIds();
      return !activeOrderIds.has(order.id);
    };

    for (const level of this._state.levels) {
      for (const clientOrderId of [...(level.pendingBuyClientOrderIds ?? [])]) {
        await this._placeBuyOrder(
          level,
          new Decimal(this._state.quotePerLevel),
          clientOrderId,
        );
      }
      const sellLevel = this._state.levels[level.index + 1];
      if (sellLevel) {
        for (const position of level.positions) {
          if (position.sellClientOrderId && !position.sellOrderId) {
            await this._placeSellOnLevel(sellLevel, position);
          }
        }
      }
    }

    // Check buy orders
    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (buyOrderId.startsWith("dry-")) {
          ordersKept++;
          continue;
        }
        try {
          const resp = await this._rateLimiter.query(() =>
            client.getOrder(buyOrderId),
          );
          const order = resp.data;
          if (
            FILLED_STATUSES.has(order.status) ||
            (DEAD_STATUSES.has(order.status) &&
              this._hasFilledQuantity(order)) ||
            (await isTerminalPartialFill(order))
          ) {
            if (await this._processTerminalBuy(level, order, false)) {
              buysFilled++;
              settledBuyLevelIndices.add(level.index);
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            this._removeBuyOrder(level, buyOrderId);
            ordersDead++;
          } else {
            ordersKept++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          if (err instanceof NotFoundError) {
            this._removeBuyOrder(level, buyOrderId);
            ordersDead++;
            continue;
          }
          throw new Error(
            `Unable to reconcile buy order ${buyOrderId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Check sell orders (tracked via positions)
    for (const level of this._state.levels) {
      const sellLevel = this._state.levels[level.index + 1];

      for (const pos of [...level.positions]) {
        if (!pos.sellOrderId) continue;
        const sellOrderId = pos.sellOrderId;

        if (sellOrderId.startsWith("dry-")) {
          ordersKept++;
          continue;
        }
        try {
          const resp = await this._rateLimiter.query(() =>
            client.getOrder(sellOrderId),
          );
          const order = resp.data;
          if (
            FILLED_STATUSES.has(order.status) ||
            (DEAD_STATUSES.has(order.status) &&
              this._hasFilledQuantity(order)) ||
            (await isTerminalPartialFill(order))
          ) {
            sellsFilled++;
            const fallbackSellLevel = sellLevel ?? level;
            const settlement = await this._processTerminalSell(
              level,
              fallbackSellLevel,
              pos,
              order,
              false,
            );
            if (
              pos.id.startsWith("split-") &&
              settlement.remainingBase.isZero()
            ) {
              settledSellSourceIndices.add(level.index);
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            pos.sellOrderId = null;
            pos.sellBaseSize = undefined;
            pos.sellClientOrderId = undefined;
            ordersDead++;
          } else {
            ordersKept++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          if (err instanceof NotFoundError) {
            pos.sellOrderId = null;
            pos.sellBaseSize = undefined;
            pos.sellClientOrderId = undefined;
            ordersDead++;
            continue;
          }
          throw new Error(
            `Unable to reconcile sell order ${sellOrderId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Phase 3: Handle split mode
    if (
      config.splitInvestment &&
      !config.dryRun &&
      (!this._state.splitExecuted || this._state.initializing)
    ) {
      const quoteCurrency = config.pair.split("-")[1] ?? "";
      const baseCurrency = config.pair.split("-")[0] ?? "";
      const currentPrice = await this._getCurrentPrice();
      const sellLevels = this._state.levels.slice(
        this._state.levels.length / 2,
      );
      const perLevel = new Decimal(this._state.quotePerLevel);
      const marketBuyQuote = perLevel.times(Math.max(sellLevels.length, 1));
      if (!this._state.splitOrderId && !this._state.splitAccumulatedBase) {
        const available = await this._checkBalance(quoteCurrency);
        if (available !== null && available.lt(marketBuyQuote)) {
          throw new Error(
            `Insufficient ${quoteCurrency} balance (${available.toFixed(2)}) for split buy (${marketBuyQuote}).`,
          );
        }
        this._log(
          chalk.dim(
            `  Placing market buy for ${marketBuyQuote} ${quoteCurrency}...`,
          ),
        );
      }
      this._log(
        chalk.dim(
          `  Market buy placed: ${marketBuyQuote} ${quoteCurrency}. Waiting for fill...`,
        ),
      );
      const splitExecution = await this._executeSplitMarketBuy(marketBuyQuote);
      const splitBaseAcquired = splitExecution.base;
      const splitQuoteCost = splitExecution.cost;
      const splitFeeQuote = splitExecution.fee;
      this._state.splitExecuted = true;
      if (!this._state.splitAccountingApplied) {
        this._addFee(splitFeeQuote);
        this._logTrade(
          "buy",
          currentPrice.toString(),
          splitBaseAcquired.toString(),
          "split-init",
        );
        this._state.splitAccountingApplied = true;
      }
      this._saveGridState(this._state);
      this._log(
        chalk.dim(
          `  Market buy filled: ${splitBaseAcquired} ${baseCurrency}` +
            (splitFeeQuote.gt(0)
              ? ` (fee ${splitFeeQuote.toFixed(2)} ${quoteCurrency})`
              : ""),
        ),
      );

      const sellLevelsToRestore = sellLevels.filter((sellLevel) => {
        const buyLevel = this._state!.levels[sellLevel.index - 1];
        return (
          buyLevel &&
          !settledSellSourceIndices.has(buyLevel.index) &&
          !buyLevel.positions.some(
            (position) =>
              position.id.startsWith("split-") && !!position.sellOrderId,
          )
        );
      });

      if (sellLevelsToRestore.length > 0) {
        const baseByLevel = allocateBaseOrderSizes(
          splitBaseAcquired,
          sellLevels.length,
          this._getOrderConstraints(),
          sellLevels.map((level) =>
            config.stopLoss
              ? new Decimal(config.stopLoss)
              : new Decimal(level.price),
          ),
        );
        const allocatedBase = baseByLevel.reduce(
          (sum, baseAmount) => sum.plus(baseAmount),
          new Decimal(0),
        );
        const totalSplitCost = splitQuoteCost;
        this._log(
          chalk.dim(
            `  Placing ${sellLevelsToRestore.length} initial sell orders...`,
          ),
        );
        let sellsPlaced = 0;
        await Promise.all(
          sellLevelsToRestore.map(async (sellLevel) => {
            const buyLevel = this._state!.levels[sellLevel.index - 1];
            if (buyLevel) {
              const allocationIndex = sellLevel.index - sellLevels[0].index;
              const baseForLevel = baseByLevel[allocationIndex];
              const costForLevel = totalSplitCost
                .times(baseForLevel)
                .div(allocatedBase);
              const existingPosition = buyLevel.positions.find(
                (position) =>
                  position.id.startsWith("split-") && !position.sellOrderId,
              );
              const pos: GridLevelPosition = existingPosition ?? {
                id: `split-reconcile-${sellLevel.index}`,
                baseHeld: baseForLevel.toString(),
                fillCost: costForLevel.toString(),
                sellOrderId: null,
              };
              if (!existingPosition) {
                buyLevel.positions.push(pos);
              }
              await this._placeSellOnLevel(sellLevel, pos);
              if (pos.sellOrderId) {
                sellsPlaced++;
                this._saveGridState(this._state!);
              } else if (!existingPosition && !pos.sellClientOrderId) {
                buyLevel.positions = buyLevel.positions.filter(
                  (position) => position !== pos,
                );
              }
            }
          }),
        );
        this._log(
          chalk.dim(
            `  Sell orders placed: ${sellsPlaced}/${sellLevelsToRestore.length}`,
          ),
        );
        if (sellsPlaced !== sellLevelsToRestore.length) {
          throw new Error(
            `Failed to restore all split sell orders (${sellsPlaced}/${sellLevelsToRestore.length}).`,
          );
        }
      }
    } else if (config.splitInvestment && this._state.splitExecuted) {
      this._log(
        chalk.dim(
          "  Split buy already executed in previous session — skipping.",
        ),
      );
    }

    if (this._state.initializing) {
      const currentPrice = await this._getCurrentPrice();
      const missingBuyLevels = this._state.levels
        .slice(0, this._state.levels.length / 2)
        .filter(
          (level) =>
            level.buyOrderIds.length === 0 &&
            !settledBuyLevelIndices.has(level.index) &&
            new Decimal(level.price).lt(currentPrice),
        );
      const restoreErrors: string[] = [];
      await Promise.all(
        missingBuyLevels.map(async (level) => {
          try {
            await this._placeBuyOrder(
              level,
              new Decimal(this._state!.quotePerLevel),
            );
          } catch (err) {
            rethrowIfInsecureKey(err);
            restoreErrors.push(
              err instanceof Error ? err.message : String(err),
            );
          }
        }),
      );
      if (restoreErrors.length > 0) {
        throw new Error(
          `Failed to restore ${restoreErrors.length} initial buy order${restoreErrors.length === 1 ? "" : "s"}: ${restoreErrors[0]}`,
        );
      }
      this._state.initializing = false;
      this._clearSplitExecutionState();
    }

    // Phase 4: Save and summarize
    this._saveGridState(this._state);

    this._log(
      renderReconciliationSummary(
        buysFilled,
        sellsFilled,
        ordersKept,
        ordersDead,
      ),
    );
    this._log(chalk.dim("  Grid resumed and state saved.\n"));

    if (buysFilled + sellsFilled > 0) {
      const parts: string[] = [`Grid Bot reconciled: ${config.pair}`];
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
          this._log(
            chalk.red(
              `\n  Halting grid bot: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
          this._log(
            chalk.yellow(
              "  Open exchange orders were NOT cancelled (signing is no longer safe).\n" +
                "  Fix the key permissions, then cancel manually with: revx order cancel --all",
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
        this._log(chalk.dim("\n  Price source exhausted; stopping loop."));
        this.stop();
        break;
      }

      this._tradeLogStart = this._state?.tradeLog.length ?? 0;

      try {
        await this._tick(tick.price);
        this._lastError = null;
      } catch (err) {
        if (err instanceof InsecureKeyPermissionsError) {
          this._log(
            chalk.red(
              `\n  Halting grid bot: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
          this._log(
            chalk.yellow(
              "  Open exchange orders were NOT cancelled (signing is no longer safe).\n" +
                "  Fix the key permissions, then cancel manually with: revx order cancel --all",
            ),
          );
          this.stop();
          throw err;
        }
        this._lastError = err instanceof Error ? err.message : String(err);
      }

      try {
        this._render();
        this._emitTickEvent(tick.price, tick.timestamp);
        this._statusReporter?.update(this._renderStatusCard());
      } catch (err) {
        this._lastError = `Reporting failed: ${err instanceof Error ? err.message : String(err)}`;
      }

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

  private _computePnl(currentPrice: Decimal): {
    position: Decimal;
    realizedPnl: Decimal;
    unrealized: Decimal;
    totalPnl: Decimal;
    netValue: Decimal;
    openOrders: number;
  } {
    const state = this._state!;
    let position = new Decimal(0);
    let costBasis = new Decimal(0);
    let openOrders = 0;
    for (const lv of state.levels) {
      openOrders += lv.buyOrderIds.length;
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
        if (pos.sellOrderId) openOrders++;
      }
    }
    const realizedPnl = new Decimal(state.stats.realizedPnl ?? "0");
    const unrealized = position.times(currentPrice).minus(costBasis);
    const totalPnl = realizedPnl.plus(unrealized);
    const netValue = new Decimal(state.config.investment).plus(totalPnl);
    return {
      position,
      realizedPnl,
      unrealized,
      totalPnl,
      netValue,
      openOrders,
    };
  }

  private _emitTickEvent(price: Decimal, timestamp: number): void {
    if (!this._onTick || !this._state) return;
    const fills: string[] = [];
    const newEntries = this._state.tradeLog.slice(this._tradeLogStart);
    for (const e of newEntries) {
      const sign = e.side === "buy" ? "BUY" : "SELL";
      fills.push(`${sign} ${e.quantity}@${e.price}`);
    }
    const { position, realizedPnl, unrealized, openOrders } =
      this._computePnl(price);
    this._onTick({
      index: this._tickCount,
      timestamp,
      price,
      fills,
      position,
      realizedPnl,
      unrealizedPnl: unrealized,
      openOrders,
    });
  }

  private _saveRunningState(): void {
    const state = this._state!;
    if (this._statusReporter) {
      state.statusMessages = this._statusReporter.snapshot();
    }
    this._saveGridState(state);
  }

  private _renderStatusCard(): string {
    const state = this._state!;
    const cs = this._cs;
    const price = this._currentPrice ?? new Decimal(state.gridPrice);
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
    const ladder = renderOrderLadder(state, price, {
      maxRows: LADDER_MAX_ROWS,
    });
    const riskLine = renderRiskLine(state, price);
    const body = [
      `${glyph} Grid ${state.pair}${mode}  ${label}`,
      `Price ${fmtPrice(price, cs)} · Pos ${position.toFixed()} ${base}`,
      `Realized ${fmtSignedPnl(realizedPnl, cs)} · Unreal ${fmtSignedPnl(unrealized, cs)}`,
      `Total ${fmtSignedPnl(totalPnl, cs)} · Net ${fmtMoney(netValue, cs)}`,
      `Fills ${s.totalBuys} buys · ${s.totalSells} sells · Up ${fmtUptime(Date.now() - this._startTime)}`,
      ...(riskLine ? [riskLine] : []),
      ...(ladder.length > 0 ? ["", ...ladder] : []),
      "",
      `Updated ${fmtLocalDateTime()}`,
    ].join("\n");
    return "```\n" + mdV2CodeEscape(body) + "\n```";
  }

  private async _tick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client!;
    this._warnings = [];
    this._connections = loadConnections().filter((c) => c.enabled);

    this._currentPrice = currentPrice;

    if (this._config.stopLoss) {
      const stopLossPrice = new Decimal(this._config.stopLoss);
      if (currentPrice.lte(stopLossPrice)) {
        await this._triggerStopLoss(currentPrice);
        this._tickCount++;
        return;
      }
    }

    this._checkBoundary(currentPrice);

    if (this._config.dryRun) {
      await this._dryRunTick(currentPrice);
      this._tickCount++;
      if (this._shouldRebuildUp) {
        this._shouldRebuildUp = false;
        const hasOpenPositions = state.levels.some(
          (l) => l.positions.length > 0,
        );
        if (hasOpenPositions || this._hasUnresolvedPlacementIntents()) {
          this._warnings.push(
            "Trailing up deferred: open positions or unresolved placements present, will retry next tick",
          );
        } else {
          await this._rebuildGridUp(currentPrice);
        }
      }
      return;
    }

    // Fetch all active order IDs for this pair
    let activeOrderIds: Set<string>;
    try {
      activeOrderIds = await this._getActiveOrderIds();
    } catch (err) {
      throw new Error(
        `Failed to fetch active orders: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check each level's buy orders
    for (const level of state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (activeOrderIds.has(buyOrderId)) continue;

        try {
          const resp = await this._rateLimiter.query(() =>
            client.getOrder(buyOrderId),
          );
          const order = resp.data;
          if (
            FILLED_STATUSES.has(order.status) ||
            (DEAD_STATUSES.has(order.status) &&
              this._hasFilledQuantity(order)) ||
            order.status === PARTIALLY_FILLED_STATUS
          ) {
            await this._processTerminalBuy(level, order, true);
          } else if (DEAD_STATUSES.has(order.status)) {
            this._removeBuyOrder(level, buyOrderId);
            await this._replaceGridBuy(level);
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
          );
        }
      }
    }

    // Check each level's positions for sell fills
    for (const level of state.levels) {
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;

      for (const pos of [...level.positions]) {
        if (!pos.sellOrderId || activeOrderIds.has(pos.sellOrderId)) continue;

        try {
          const resp = await this._rateLimiter.query(() =>
            client.getOrder(pos.sellOrderId!),
          );
          const order = resp.data;
          if (
            FILLED_STATUSES.has(order.status) ||
            (DEAD_STATUSES.has(order.status) &&
              this._hasFilledQuantity(order)) ||
            order.status === PARTIALLY_FILLED_STATUS
          ) {
            await this._processTerminalSell(level, sellLevel, pos, order, true);
          } else if (DEAD_STATUSES.has(order.status)) {
            pos.sellOrderId = null;
            pos.sellBaseSize = undefined;
            pos.sellClientOrderId = undefined;
            // HELD recovery below will re-place the sell
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Check sell #${level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
          );
        }
      }
    }

    // Orphan recovery: empty levels below price get buy orders
    const quoteCurrency = this._config.pair.split("-")[1] ?? "";
    const recoveryBalance = this._config.dryRun
      ? null
      : await this._checkBalance(quoteCurrency);
    const canPlaceBuys =
      recoveryBalance === null ||
      recoveryBalance.gte(new Decimal(state.quotePerLevel));
    if (canPlaceBuys) {
      for (const level of state.levels) {
        if (
          level.positions.length === 0 &&
          new Decimal(level.price).lt(currentPrice) &&
          new Decimal(level.price).lt(new Decimal(state.gridPrice))
        ) {
          const expected = level.expectedBuys ?? 1;
          const missing = expected - level.buyOrderIds.length;
          for (let i = 0; i < missing; i++) {
            await this._replaceGridBuy(level);
          }
        }
      }
    }

    // HELD recovery: positions without a sell order get one placed
    for (const level of state.levels) {
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      for (const pos of level.positions) {
        if (!pos.sellOrderId) {
          const baseHeld = new Decimal(pos.baseHeld);
          if (baseHeld.gt(0)) {
            await this._placeSellOnLevel(sellLevel, pos);
          }
        }
      }
    }

    this._saveRunningState();
    this._tickCount++;

    if (this._shouldRebuildUp) {
      this._shouldRebuildUp = false;
      const hasOpenPositions = state.levels.some((l) => l.positions.length > 0);
      if (hasOpenPositions || this._hasUnresolvedPlacementIntents()) {
        this._warnings.push(
          "Trailing up deferred: open positions or unresolved placements present, will retry next tick",
        );
      } else {
        await this._rebuildGridUp(currentPrice);
      }
    }
  }

  // --------------- dry run ---------------

  private async _dryRunTick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;

    // Simulate buy fills — process all buy orders at each level
    for (const level of state.levels) {
      const levelPrice = new Decimal(level.price);

      for (const buyOrderId of [...level.buyOrderIds]) {
        // Buy limit order fills when market price <= order price
        if (!currentPrice.lte(levelPrice)) continue;

        const quotePerLevel = new Decimal(state.quotePerLevel);
        const baseStep = this._getBaseStep();
        const filledQty = floorToStep(quotePerLevel.div(levelPrice), baseStep);

        const pos: GridLevelPosition = {
          id: `dry-${randomUUID().slice(0, 8)}`,
          baseHeld: filledQty.toString(),
          fillCost: quotePerLevel.toString(),
          sellOrderId: null,
        };
        level.positions.push(pos);
        this._removeBuyOrder(level, buyOrderId);
        state.stats.totalBuys++;
        this._logTrade(
          "buy",
          level.price,
          filledQty.toString(),
          `dry-${randomUUID().slice(0, 8)}`,
        );

        const base = this._config.pair.split("-")[0] ?? "";
        const cs = this._cs;
        this._notify(
          `Grid Bot ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${filledQty} ${base} [DRY RUN]`,
        );

        // Place sell on the level above
        const sellLevel = state.levels[level.index + 1];
        if (sellLevel) {
          pos.sellOrderId = `dry-sell-${randomUUID().slice(0, 8)}`;
          pos.sellBaseSize = pos.baseHeld;
        }
      }
    }

    // Simulate sell fills
    for (const level of state.levels) {
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      const sellLevelPrice = new Decimal(sellLevel.price);

      for (const pos of [...level.positions]) {
        // Sell limit order fills when market price >= order price
        if (!pos.sellOrderId || !currentPrice.gte(sellLevelPrice)) continue;

        const filledQty = new Decimal(pos.baseHeld);
        if (filledQty.lte(0)) continue;

        const costBasis =
          pos.fillCost && pos.fillCost !== "0"
            ? new Decimal(pos.fillCost)
            : new Decimal(state.quotePerLevel);
        const revenue = filledQty.times(sellLevelPrice);
        const profit = revenue.minus(costBasis);

        level.positions = level.positions.filter((p) => p !== pos);
        state.stats.totalSells++;
        state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
          .plus(profit)
          .toString();
        this._logTrade(
          "sell",
          sellLevelPrice.toString(),
          filledQty.toString(),
          `dry-${randomUUID().slice(0, 8)}`,
          profit.toFixed(2),
        );

        const base = this._config.pair.split("-")[0] ?? "";
        const cs = this._cs;
        this._notify(
          `Grid Bot ${this._config.pair}: SELL filled @ ${cs}${sellLevelPrice} | ` +
            `${filledQty} ${base} | profit ${fmtSignedPnl(profit, cs)} | ` +
            `total P&L: ${fmtSignedPnl(new Decimal(state.stats.realizedPnl), cs)} [DRY RUN]`,
        );

        // Place buy back on this level — each sell independently redeploys capital (multi-slot)
        level.buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
      }
    }

    // Orphan recovery: empty levels below price get buy orders (excluding last level)
    for (const level of state.levels) {
      if (
        level.buyOrderIds.length === 0 &&
        level.positions.length === 0 &&
        new Decimal(level.price).lt(currentPrice) &&
        new Decimal(level.price).lt(new Decimal(state.gridPrice))
      ) {
        level.buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
      }
    }

    // HELD recovery: positions without a sell order get one placed
    for (const level of state.levels) {
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      for (const pos of level.positions) {
        if (!pos.sellOrderId && new Decimal(pos.baseHeld).gt(0)) {
          pos.sellOrderId = `dry-sell-${randomUUID().slice(0, 8)}`;
          pos.sellBaseSize = pos.baseHeld;
        }
      }
    }

    this._saveRunningState();
  }

  // --------------- order placement ---------------

  // Place a sell order on sellLevel for the given position.
  // The position lives on the level below (sellLevel.index - 1).
  private async _placeSellOnLevel(
    sellLevel: GridLevelState,
    position: GridLevelPosition,
  ): Promise<void> {
    const heldBase = new Decimal(position.baseHeld);
    if (heldBase.lte(0)) return;

    if (position.sellOrderId) {
      this._warnings.push(
        `Sell: position already has order ${position.sellOrderId}`,
      );
      return;
    }

    if (this._config.dryRun) {
      position.sellOrderId = `dry-sell-${sellLevel.index}`;
      position.sellBaseSize = heldBase.toString();
      return;
    }

    try {
      const baseAmount = normalizeBaseOrderSize(
        heldBase,
        this._getOrderConstraints(),
        new Decimal(sellLevel.price),
      );
      position.sellClientOrderId ??= randomUUID();
      position.sellBaseSize = baseAmount.toString();
      this._saveGridState(this._state!);
      const resp = await this._rateLimiter.place(() =>
        this._client!.placeOrder({
          symbol: this._config.pair,
          side: "sell",
          clientOrderId: position.sellClientOrderId,
          limit: {
            price: sellLevel.price,
            baseSize: baseAmount.toString(),
            executionInstructions: ["post_only"],
          },
        }),
      );
      position.sellOrderId = resp.data.venue_order_id;
      this._saveGridState(this._state!);
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._warnings.push(
        `Sell @${sellLevel.price}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _replaceGridBuy(level: GridLevelState): Promise<void> {
    const quotePerLevel = new Decimal(this._state!.quotePerLevel);

    try {
      await this._placeBuyOrder(
        level,
        quotePerLevel,
        level.pendingBuyClientOrderIds?.[0],
      );
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._warnings.push(
        `Buy @${level.price}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _placeBuyOrder(
    level: GridLevelState,
    quoteSize: Decimal,
    clientOrderId: string = randomUUID(),
  ): Promise<string> {
    if (this._config.dryRun) {
      const orderId = `dry-buy-${randomUUID().slice(0, 8)}`;
      level.buyOrderIds.push(orderId);
      return orderId;
    }

    level.pendingBuyClientOrderIds ??= [];
    level.pendingBuyQuoteSizes ??= {};
    const persistedQuoteSize = level.pendingBuyQuoteSizes[clientOrderId];
    const requestedQuoteSize = persistedQuoteSize
      ? new Decimal(persistedQuoteSize)
      : quoteSize;
    if (!level.pendingBuyClientOrderIds.includes(clientOrderId)) {
      level.pendingBuyClientOrderIds.push(clientOrderId);
      level.pendingBuyQuoteSizes[clientOrderId] = requestedQuoteSize.toString();
      this._saveGridState(this._state!);
    }
    const resp = await this._rateLimiter.place(() =>
      this._client!.placeOrder({
        symbol: this._config.pair,
        side: "buy",
        clientOrderId,
        limit: {
          price: level.price,
          quoteSize: requestedQuoteSize.toString(),
          executionInstructions: ["post_only"],
        },
      }),
    );
    const orderId = resp.data.venue_order_id;
    level.pendingBuyClientOrderIds = level.pendingBuyClientOrderIds.filter(
      (pendingId) => pendingId !== clientOrderId,
    );
    delete level.pendingBuyQuoteSizes[clientOrderId];
    level.buyOrderQuoteSizes ??= {};
    level.buyOrderQuoteSizes[orderId] = requestedQuoteSize.toString();
    if (!level.buyOrderIds.includes(orderId)) {
      level.buyOrderIds.push(orderId);
    }
    this._saveGridState(this._state!);
    return orderId;
  }

  // --------------- notifications & logging ---------------

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
      if (r.status === "fulfilled" && r.value.success) {
        this._lastNotifyOk = Date.now();
      }
    }
  }

  private _logTrade(
    side: "buy" | "sell",
    price: string,
    quantity: string,
    orderId: string,
    profit?: string,
    fee?: string,
  ): void {
    const entry: GridTradeEntry = {
      ts: new Date().toISOString(),
      side,
      price,
      quantity,
      orderId,
    };
    if (profit !== undefined) entry.profit = profit;
    if (fee !== undefined && new Decimal(fee).gt(0)) entry.fee = fee;
    this._state!.tradeLog.push(entry);
  }

  // --------------- rendering ---------------

  private _render(): void {
    if (!this._state) return;
    if (this._suppressDashboard) return;

    let currentPrice: Decimal;
    try {
      currentPrice = this._currentPrice ?? new Decimal(this._state.gridPrice);
    } catch {
      currentPrice = new Decimal(this._state.gridPrice);
    }

    const data: DashboardData = {
      state: this._state,
      currentPrice,
      uptime: Date.now() - this._startTime,
      tickCount: this._tickCount,
      lastError: this._lastError,
      warnings: this._warnings,
      telegramConnections: this._connections.length,
      intervalSec: this._config.intervalSec,
      lastNotifyOk: this._lastNotifyOk,
    };

    process.stdout.write("\x1B[2J\x1B[H");
    this._log(renderDashboard(data));
  }
}
