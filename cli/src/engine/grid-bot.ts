import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import {
  RevolutXClient,
  InsecureKeyPermissionsError,
} from "@revolut/revolut-x-api";
import type { CurrencyPair, OrderDetails } from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";
import chalk from "chalk";
import {
  saveGridState,
  loadGridState,
  deleteGridState,
  type GridState,
  type GridLevelState,
  type GridTradeEntry,
} from "../db/grid-store.js";
import { loadConnections, type TelegramConnection } from "../db/store.js";
import { sendWithRetries } from "./notify.js";
import {
  renderDashboard,
  renderShutdownSummary,
  renderReconciliationSummary,
  getCurrSymbol,
  type DashboardData,
} from "./grid-renderer.js";

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

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const ORDER_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ForegroundGridBot {
  private _config: GridBotConfig;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _client: RevolutXClient | null = null;
  private _state: GridState | null = null;
  private _startTime = 0;
  private _currentPrice: Decimal | null = null;
  private _previousPrice: Decimal | null = null;
  private _tickCount = 0;
  private _lastError: string | null = null;
  private _warnings: string[] = [];
  private _pairInfo: CurrencyPair | null = null;
  private _connections: TelegramConnection[] = [];
  private _boundaryAlerted = false;
  private _shouldRebuildUp = false;
  private _lastNotifyOk = 0;
  private _cs: string;

  constructor(config: GridBotConfig) {
    this._config = config;
    this._cs = getCurrSymbol(config.pair);
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

  get state(): GridState | null {
    return this._state;
  }

  async run(): Promise<void> {
    this._running = true;
    this._startTime = Date.now();
    this._client = new RevolutXClient({
      isAgent: true,
      enforceKeyPermissions: true,
    });
    this._connections = loadConnections().filter((c) => c.enabled);

    if (!this._client.isAuthenticated) {
      throw new Error(
        "API credentials not configured. Run 'revx configure' first.",
      );
    }

    await this._fetchPairInfo();
    const existingState = loadGridState(this._config.pair);

    if (existingState && this._config.reset) {
      console.log(chalk.dim("  --reset flag: discarding saved state..."));
      deleteGridState(this._config.pair);
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
          `Saved grid has ${savedLevels} levels with ${savedRangePct}% range ` +
            `but you requested ${newLevels} levels with ${newRangePct}% range. ` +
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

      await this._reconcileAndInit(existingState);
    } else {
      await this._initNewGrid();
    }
    const activeConfig = this._state!.config;
    const rangePctDisplay = new Decimal(activeConfig.rangePct)
      .times(100)
      .toFixed(1);
    const modeLabel = activeConfig.dryRun ? " [DRY RUN]" : "";
    this._notify(
      `Grid Bot started${modeLabel}: ${this._state!.pair} | ` +
        `${activeConfig.levels} levels | \u00B1${rangePctDisplay}% | ` +
        `${activeConfig.investment} ${this._state!.pair.split("-")[1] ?? ""}`,
    );
    await this._loop();
  }

  async shutdown(): Promise<void> {
    if (!this._state || !this._client) return;

    console.log(chalk.dim("\n  Cancelling open orders..."));
    let cancelled = 0;
    let remaining = 0;
    for (const level of this._state.levels) {
      if (level.buyOrderId) {
        try {
          if (!this._config.dryRun) {
            await this._client.cancelOrder(level.buyOrderId);
          }
          level.buyOrderId = null;
          cancelled++;
        } catch {
          remaining++;
        }
      }
      if (level.sellOrderId) {
        try {
          if (!this._config.dryRun) {
            await this._client.cancelOrder(level.sellOrderId);
          }
          level.sellOrderId = null;
          cancelled++;
        } catch {
          remaining++;
        }
      }
    }

    if (remaining === 0) {
      deleteGridState(this._state.pair);
    } else {
      saveGridState(this._state);
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
      currentPrice = await this._getMidPrice();
    } catch {
      currentPrice = new Decimal(this._state.gridPrice);
    }

    console.log(renderShutdownSummary(this._state, currentPrice, remaining));

    const s = this._state.stats;
    let totalBaseHeld = new Decimal(0);
    let costBasis = new Decimal(0);
    for (const lv of this._state.levels) {
      if (lv.hasPosition) {
        const held = new Decimal(lv.baseHeld);
        totalBaseHeld = totalBaseHeld.plus(held);
        const cost =
          lv.fillCost && lv.fillCost !== "0"
            ? new Decimal(lv.fillCost)
            : held.times(new Decimal(lv.price));
        costBasis = costBasis.plus(cost);
      }
    }
    const realizedPnl = new Decimal(s.realizedPnl);
    const unrealized = totalBaseHeld.times(currentPrice).minus(costBasis);
    const totalPnl = realizedPnl.plus(unrealized);
    const investment = new Decimal(this._state.config.investment);
    const netValue = investment.plus(totalPnl);

    const cs = this._cs;
    const fmtSigned = (v: Decimal) => {
      const sign = v.gte(0) ? "+" : "";
      return `${sign}${cs}${v.toFixed(2)}`;
    };

    await this._notifyAndWait(
      `Grid Bot stopped: ${this._state.pair}\n` +
        `${s.totalBuys} buys, ${s.totalSells} sells\n` +
        `Realized P&L: ${fmtSigned(realizedPnl)}\n` +
        `Unrealized: ${fmtSigned(unrealized)}\n` +
        `Total P&L: ${fmtSigned(totalPnl)}\n` +
        `Net Value: ${cs}${netValue.toFixed(2)}`,
    );
  }

  // --------------- helpers ---------------

  private async _fetchPairInfo(): Promise<void> {
    const client = this._client!;
    try {
      const pairs = await client.getCurrencyPairs();
      const slashPair = this._config.pair.replace("-", "/");
      this._pairInfo = pairs[slashPair] ?? null;
      if (!this._pairInfo) {
        console.log(
          chalk.yellow(
            `\n  Warning: Pair info not found for ${this._config.pair}. Using default precision — orders may be rejected.`,
          ),
        );
      }
    } catch (err) {
      this._pairInfo = null;
      console.log(
        chalk.yellow(
          `\n  Warning: Failed to fetch pair info: ${err instanceof Error ? err.message : String(err)}. Using default precision — orders may be rejected.`,
        ),
      );
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

  private _getMinOrderQuote(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.min_order_size_quote)
      : new Decimal("0");
  }

  private _getMinOrderBase(): Decimal {
    return this._pairInfo
      ? new Decimal(this._pairInfo.min_order_size)
      : new Decimal("0");
  }

  private async _getMidPrice(): Promise<Decimal> {
    const client = this._client!;
    const resp = await client.getOrderBook(this._config.pair, { limit: 1 });
    const bestBid = resp.data.bids[0];
    const bestAsk = resp.data.asks[0];
    if (!bestBid || !bestAsk) {
      throw new Error(`No order book data for ${this._config.pair}`);
    }
    return new Decimal(bestBid.price).plus(new Decimal(bestAsk.price)).div(2);
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

  private _checkBoundary(currentPrice: Decimal): void {
    const state = this._state;
    if (!state) return;

    const levels = state.levels;
    const lower = new Decimal(levels[0].price);
    const upper = new Decimal(levels[levels.length - 1].price);
    const ratio = upper
      .div(lower)
      .pow(new Decimal(1).div(levels.length - 1));
    const cs = this._cs;

    if (this._config.trailingUp && currentPrice.gt(upper.times(ratio))) {
      this._shouldRebuildUp = true;
      this._boundaryAlerted = false;
      return;
    }

    if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
      const below = currentPrice.lt(lower);
      const direction = below ? "below" : "above";
      const boundary = below ? lower : upper;
      this._warnings.push(
        `Price ${direction} grid range (${cs}${boundary.toFixed(2)})`,
      );
      if (!this._boundaryAlerted) {
        this._boundaryAlerted = true;
        const risk = below
          ? "Buy orders may keep filling without matching sells — accumulating inventory."
          : "Price is above all grid levels — bot is idle with no active orders.";
        this._notify(
          `Grid Bot ${state.pair}: Price exited grid range (${direction} ${cs}${boundary.toFixed(2)}). ` +
            `Current: ${cs}${currentPrice.toFixed(2)}. ${risk}`,
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

    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        if (level.buyOrderId) {
          cancels.push(
            client
              .cancelOrder(level.buyOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
        if (level.sellOrderId) {
          cancels.push(
            client
              .cancelOrder(level.sellOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
      }
      await Promise.all(cancels);
    }

    for (const level of state.levels) {
      level.buyOrderId = null;
      level.sellOrderId = null;
      level.hasPosition = false;
      level.baseHeld = "0";
      level.fillCost = "0";
    }

    const rangePct = new Decimal(this._config.rangePct);
    const lower = currentPrice.times(new Decimal(1).minus(rangePct));
    const upper = currentPrice.times(new Decimal(1).plus(rangePct));
    const ratio = upper
      .div(lower)
      .pow(new Decimal(1).div(state.levels.length - 1));
    const quoteStep = this._getQuoteStep();

    for (let i = 0; i < state.levels.length; i++) {
      state.levels[i].price = lower
        .times(ratio.pow(i))
        .toDecimalPlaces(quoteStep.decimalPlaces(), Decimal.ROUND_DOWN)
        .toString();
      state.levels[i].index = i;
    }

    state.gridPrice = currentPrice.toString();

    for (const level of state.levels) {
      if (new Decimal(level.price).lt(currentPrice)) {
        try {
          const orderId = await this._placeBuyOrder(
            level,
            new Decimal(state.quotePerLevel),
          );
          level.buyOrderId = orderId;
          await sleep(ORDER_DELAY_MS);
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Rebuild buy @${level.price}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    state.shiftCount = (state.shiftCount ?? 0) + 1;
    saveGridState(state);

    this._notify(
      `Grid Bot ${state.pair}: trailing up — grid rebuilt around ${cs}${currentPrice.toFixed(2)} ` +
        `(shift #${state.shiftCount})`,
    );
  }

  private async _triggerStopLoss(currentPrice: Decimal): Promise<void> {
    const state = this._state!;
    const client = this._client;
    const cs = this._cs;

    // 1. Cancel all open orders to free reserved funds
    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        if (level.buyOrderId) {
          cancels.push(
            client
              .cancelOrder(level.buyOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
        if (level.sellOrderId) {
          cancels.push(
            client
              .cancelOrder(level.sellOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
      }
      await Promise.all(cancels);
    }

    for (const level of state.levels) {
      level.buyOrderId = null;
      level.sellOrderId = null;
    }

    // 2. Sell all accumulated base asset via market order
    const baseStep = this._getBaseStep();
    const totalBase = state.levels
      .filter((l) => l.hasPosition && new Decimal(l.baseHeld).gt(0))
      .reduce((sum, l) => sum.plus(l.baseHeld), new Decimal(0))
      .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

    if (totalBase.gt(0)) {
      if (!this._config.dryRun && client) {
        try {
          const resp = await client.placeOrder({
            symbol: this._config.pair,
            side: "sell",
            market: { baseSize: totalBase.toString() },
          });
          const filled = await this._awaitOrderFill(resp.data.venue_order_id);
          const netBase = this._netBase(filled);
          const filledAmount = this._filledAmount(filled, currentPrice);
          const feeQuote = this._feeQuote(filled, currentPrice);
          const costBasis = state.levels
            .filter((l) => l.hasPosition)
            .reduce(
              (sum, l) =>
                sum.plus(
                  l.fillCost && l.fillCost !== "0"
                    ? l.fillCost
                    : state.quotePerLevel,
                ),
              new Decimal(0),
            );
          const revenue = filledAmount.minus(feeQuote);
          const pnl = revenue.minus(costBasis);
          this._addFee(feeQuote);
          state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
            .plus(pnl)
            .toString();
          state.stats.totalSells++;
          this._logTrade(
            "sell",
            currentPrice.toString(),
            netBase.toString(),
            "stop-loss",
            pnl.toFixed(2),
            feeQuote.toString(),
          );
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Stop-loss market sell failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Clear positions regardless of whether real sell succeeded
      for (const level of state.levels) {
        level.hasPosition = false;
        level.baseHeld = "0";
        level.fillCost = "0";
      }
    }

    this._notify(
      `Grid Bot ${state.pair}: STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)}. ` +
        `Sold ${totalBase} base. Realized P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}`,
    );

    saveGridState(state);
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
        const resp = await client.getOrder(orderId);
        const order = resp.data;

        if (FILLED_STATUSES.has(order.status)) {
          return order;
        }

        if (DEAD_STATUSES.has(order.status)) {
          throw new Error(`Market buy order ${order.status}: ${orderId}`);
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("Market buy order")
        ) {
          throw err;
        }
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

  private _addFee(fee: Decimal): void {
    if (!this._state || fee.lte(0)) return;
    const cur = new Decimal(this._state.stats.totalFees ?? "0");
    this._state.stats.totalFees = cur.plus(fee).toString();
  }

  // --------------- initialization ---------------

  private async _initNewGrid(): Promise<void> {
    const config = this._config;

    console.log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getMidPrice();
    console.log(chalk.dim(`  Current mid-price: ${currentPrice}`));

    const quoteCurrency = config.pair.split("-")[1] ?? "";
    const investment = new Decimal(config.investment);
    let insufficientBalance = false;
    if (!config.dryRun) {
      const available = await this._checkBalance(quoteCurrency);
      if (available !== null && available.lt(investment)) {
        console.log(
          chalk.yellow(
            `  Warning: Available ${quoteCurrency} balance (${available.toFixed(2)}) ` +
              `is less than investment (${investment.toFixed(2)}). Skipping order placement.`,
          ),
        );
        insufficientBalance = true;
      }
    }

    const minQuote = this._getMinOrderQuote();
    const minBase = this._getMinOrderBase();

    const rangePct = new Decimal(config.rangePct);
    const lower = currentPrice.times(new Decimal(1).minus(rangePct));
    const upper = currentPrice.times(new Decimal(1).plus(rangePct));
    const ratio = upper.div(lower).pow(new Decimal(1).div(config.levels - 1));
    const quoteStep = this._getQuoteStep();
    const baseStep = this._getBaseStep();

    const levels: GridLevelState[] = [];
    for (let i = 0; i < config.levels; i++) {
      const rawPrice = lower.times(ratio.pow(i));
      const price = rawPrice.toDecimalPlaces(
        quoteStep.decimalPlaces(),
        Decimal.ROUND_DOWN,
      );
      levels.push({
        index: i,
        price: price.toString(),
        buyOrderId: null,
        sellOrderId: null,
        hasPosition: false,
        baseHeld: "0",
        fillCost: "0",
      });
    }

    // Validate stop-loss: must be strictly below the lowest grid level
    if (config.stopLoss) {
      const slPrice = new Decimal(config.stopLoss);
      const lowestLevel = new Decimal(levels[0].price);
      if (slPrice.gte(lowestLevel)) {
        throw new Error(
          `Stop-loss price (${slPrice.toFixed(2)}) must be strictly below ` +
            `the lowest grid level (${lowestLevel.toFixed(2)}). `,
        );
      }
    }

    // Determine sell levels for split mode (strictly above current price)
    const sellLevelIndices = new Set<number>();
    if (config.splitInvestment) {
      for (const l of levels) {
        if (new Decimal(l.price).gt(currentPrice)) {
          sellLevelIndices.add(l.index);
        }
      }
    }

    // Count buy levels
    let buyLevelCount = 0;
    for (const l of levels) {
      const price = new Decimal(l.price);
      if (
        config.splitInvestment
          ? price.lte(currentPrice)
          : price.lt(currentPrice)
      ) {
        buyLevelCount++;
      }
    }

    const totalCapitalLevels = config.splitInvestment
      ? sellLevelIndices.size + buyLevelCount
      : levels.filter((l) => new Decimal(l.price).lt(currentPrice)).length;
    const quotePerLevel = investment
      .div(Math.max(totalCapitalLevels, 1))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    let splitExecuted = false;
    let splitBaseAcquired: Decimal | null = null;
    let splitFilledAmount: Decimal | null = null;
    let splitFeeQuote = new Decimal(0);
    if (config.splitInvestment && !config.dryRun && !insufficientBalance) {
      const marketBuyQuote = quotePerLevel
        .times(sellLevelIndices.size)
        .toFixed(2);
      console.log(
        chalk.dim(
          `  Placing market buy for ${marketBuyQuote} ${quoteCurrency}...`,
        ),
      );
      const orderResp = await this._client!.placeOrder({
        symbol: config.pair,
        side: "buy",
        market: { quoteSize: marketBuyQuote },
      });
      console.log(
        chalk.dim(
          `  Market buy placed: ${marketBuyQuote} ${quoteCurrency}. Waiting for fill...`,
        ),
      );
      const filledOrder = await this._awaitOrderFill(
        orderResp.data.venue_order_id,
      );
      splitBaseAcquired = this._netBase(filledOrder);
      splitFilledAmount = this._filledAmount(filledOrder, currentPrice);
      splitFeeQuote = this._feeQuote(filledOrder, currentPrice);
      splitExecuted = true;
      const baseCurrency = config.pair.split("-")[0] ?? "";
      console.log(
        chalk.dim(
          `  Market buy filled: ${splitBaseAcquired} ${baseCurrency}` +
            (splitFeeQuote.gt(0)
              ? ` (fee ${splitFeeQuote.toFixed(2)} ${quoteCurrency})`
              : ""),
        ),
      );
    }

    if (minQuote.gt(0) && quotePerLevel.lt(minQuote)) {
      console.log(
        chalk.yellow(
          `  Warning: Quote per level (${quotePerLevel}) is below min order size (${minQuote}). Orders may be rejected.`,
        ),
      );
    }

    const strategyId = randomUUID().slice(0, 8);
    this._state = {
      id: strategyId,
      pair: config.pair,
      version: 2,
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
      splitExecuted,
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

    // --- Place initial buy orders ---
    const buyLevels = levels.filter((l) =>
      config.splitInvestment
        ? new Decimal(l.price).lte(currentPrice)
        : new Decimal(l.price).lt(currentPrice),
    );
    let buysPlaced = 0;
    const errors: string[] = [];
    if (!insufficientBalance) {
      console.log(
        chalk.dim(`  Placing ${buyLevels.length} initial buy orders...`),
      );
      for (const level of buyLevels) {
        try {
          const orderId = await this._placeBuyOrder(level, quotePerLevel);
          level.buyOrderId = orderId;
          buysPlaced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`buy @${level.price}: ${msg}`);
        }
        await sleep(ORDER_DELAY_MS);
      }

      if (buysPlaced === 0 && buyLevels.length > 0) {
        const detail = errors.length > 0 ? `\n  First error: ${errors[0]}` : "";
        throw new Error(
          `Failed to place any initial buy orders (0/${buyLevels.length}).${detail}`,
        );
      }

      console.log(
        chalk.dim(
          `  Buy orders placed: ${buysPlaced}/${buyLevels.length}` +
            (errors.length > 0
              ? chalk.yellow(` (${errors.length} failed)`)
              : ""),
        ),
      );
    }

    // --- Place initial sell orders for split mode ---
    let sellsPlaced = 0;
    if (
      config.splitInvestment &&
      sellLevelIndices.size > 0 &&
      !insufficientBalance
    ) {
      const totalBase =
        splitBaseAcquired ??
        quotePerLevel
          .times(sellLevelIndices.size)
          .div(currentPrice)
          .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      const basePerLevel = totalBase
        .div(sellLevelIndices.size)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      const totalSplitCost = splitFilledAmount
        ? splitFilledAmount.plus(splitFeeQuote)
        : null;
      const costPerLevel = totalSplitCost
        ? totalSplitCost.div(sellLevelIndices.size)
        : null;
      this._addFee(splitFeeQuote);

      if (basePerLevel.gt(0)) {
        if (minBase.gt(0) && basePerLevel.lt(minBase)) {
          console.log(
            chalk.yellow(
              `  Warning: Base per level (${basePerLevel}) is below min order size (${minBase}). Sell orders may be rejected.`,
            ),
          );
        }

        console.log(
          chalk.dim(
            `  Placing ${sellLevelIndices.size} initial sell orders...`,
          ),
        );

        for (const sellIdx of [...sellLevelIndices].sort((a, b) => a - b)) {
          const sellLevel = levels[sellIdx];
          const buyLevel = levels[sellIdx - 1];

          if (buyLevel) {
            buyLevel.hasPosition = true;
            buyLevel.baseHeld = basePerLevel.toString();
            buyLevel.fillCost = (costPerLevel ?? quotePerLevel).toFixed(2);
          }

          await this._placeSellOnLevel(sellLevel, basePerLevel);
          if (sellLevel.sellOrderId) {
            sellsPlaced++;
          } else if (buyLevel) {
            buyLevel.hasPosition = false;
            buyLevel.baseHeld = "0";
            buyLevel.fillCost = "0";
          }
          await sleep(ORDER_DELAY_MS);
        }

        console.log(
          chalk.dim(
            `  Sell orders placed: ${sellsPlaced}/${sellLevelIndices.size}`,
          ),
        );
      }
    }

    saveGridState(this._state);

    if (errors.length > 0) {
      this._warnings = errors.slice(0, 3).map((e) => `Order failed: ${e}`);
    }
    console.log(chalk.dim("  Grid initialized and state saved.\n"));
  }

  // --------------- reconciliation ---------------

  private async _reconcileAndInit(savedState: GridState): Promise<void> {
    const config = this._config;
    const client = this._client!;

    console.log(chalk.dim("\n  Saved state found. Resuming grid..."));

    // Phase 1: Adopt saved state as-is
    this._state = savedState;

    // Update mutable config fields (geometry + split validated in run())
    this._state.config.intervalSec = config.intervalSec;
    this._state.config.dryRun = config.dryRun;

    const quoteStep = this._getQuoteStep();
    const baseStep = this._getBaseStep();
    this._state.quotePrecision = quoteStep.toString();
    this._state.basePrecision = baseStep.toString();

    const newInvestment = new Decimal(config.investment);

    // Phase 2: Verify each saved order against the exchange
    let buysFilled = 0;
    let sellsFilled = 0;
    let ordersKept = 0;
    let ordersDead = 0;

    for (const level of this._state.levels) {
      // --- Check buy order ---
      if (level.buyOrderId) {
        if (level.buyOrderId.startsWith("dry-")) {
          ordersKept++;
        } else {
          try {
            const resp = await client.getOrder(level.buyOrderId);
            const order = resp.data;
            if (FILLED_STATUSES.has(order.status)) {
              buysFilled++;
              const levelPrice = new Decimal(level.price);
              const netBase = this._netBase(order);
              const filledAmount = this._filledAmount(order, levelPrice);
              const feeQuote = this._feeQuote(order, levelPrice);
              level.hasPosition = true;
              level.baseHeld = netBase.toString();
              level.fillCost = filledAmount.plus(feeQuote).toString();
              this._state.stats.totalBuys++;
              this._addFee(feeQuote);
              this._logTrade(
                "buy",
                level.price,
                netBase.toString(),
                order.id,
                undefined,
                feeQuote.toString(),
              );
              level.buyOrderId = null;
            } else if (DEAD_STATUSES.has(order.status)) {
              level.buyOrderId = null;
              ordersDead++;
            } else {
              ordersKept++;
            }
          } catch (err) {
            rethrowIfInsecureKey(err);
            level.buyOrderId = null;
            ordersDead++;
          }
          await sleep(ORDER_DELAY_MS);
        }
      }

      // --- Check sell order ---
      if (level.sellOrderId) {
        if (level.sellOrderId.startsWith("dry-")) {
          ordersKept++;
        } else {
          try {
            const resp = await client.getOrder(level.sellOrderId);
            const order = resp.data;
            if (FILLED_STATUSES.has(order.status)) {
              sellsFilled++;
              const filledQty = new Decimal(order.filled_quantity);
              const sellPrice = new Decimal(level.price);
              const filledAmount = this._filledAmount(order, sellPrice);
              const feeQuote = this._feeQuote(order, sellPrice);
              const buyLevel = this._state.levels[level.index - 1];
              const costBasis =
                buyLevel?.fillCost && buyLevel.fillCost !== "0"
                  ? new Decimal(buyLevel.fillCost)
                  : new Decimal(this._state.quotePerLevel);
              const profit = filledAmount.minus(feeQuote).minus(costBasis);

              level.sellOrderId = null;
              this._state.stats.totalSells++;
              this._addFee(feeQuote);
              this._state.stats.realizedPnl = new Decimal(
                this._state.stats.realizedPnl,
              )
                .plus(profit)
                .toString();
              this._logTrade(
                "sell",
                sellPrice.toString(),
                filledQty.toString(),
                order.id,
                profit.toFixed(2),
                feeQuote.toString(),
              );

              // Clear position on buy level below
              if (buyLevel) {
                buyLevel.hasPosition = false;
                buyLevel.baseHeld = "0";
                buyLevel.fillCost = "0";
              }
            } else if (DEAD_STATUSES.has(order.status)) {
              level.sellOrderId = null;
              ordersDead++;
            } else {
              ordersKept++;
            }
          } catch (err) {
            rethrowIfInsecureKey(err);
            level.sellOrderId = null;
            ordersDead++;
          }
          await sleep(ORDER_DELAY_MS);
        }
      }
    }

    // Recalculate quotePerLevel if investment changed (after Phase 2 so hasPosition is up-to-date)
    if (config.investment !== this._state.config.investment) {
      const midPrice = await this._getMidPrice();
      const totalActiveLevels = this._state.levels.filter(
        (l) =>
          !!l.buyOrderId ||
          !!l.sellOrderId ||
          l.hasPosition ||
          new Decimal(l.price).lte(midPrice),
      ).length;
      const quotePerLevel = newInvestment
        .div(Math.max(totalActiveLevels, 1))
        .toDecimalPlaces(2, Decimal.ROUND_DOWN);
      this._state.quotePerLevel = quotePerLevel.toString();
      this._state.config.investment = config.investment;
      console.log(
        chalk.dim(
          `  Investment changed: quote per level recalculated to ${quotePerLevel}`,
        ),
      );
    }

    // Phase 3: Handle split mode
    if (
      config.splitInvestment &&
      !config.dryRun &&
      !this._state.splitExecuted
    ) {
      const quoteCurrency = config.pair.split("-")[1] ?? "";
      const baseCurrency = config.pair.split("-")[0] ?? "";
      const currentPrice = await this._getMidPrice();
      const sellCount = this._state.levels.filter((l) =>
        new Decimal(l.price).gt(currentPrice),
      ).length;
      const perLevel = new Decimal(this._state.quotePerLevel);
      const marketBuyQuote = perLevel.times(Math.max(sellCount, 1)).toFixed(2);

      const available = await this._checkBalance(quoteCurrency);
      if (available !== null && available.lt(new Decimal(marketBuyQuote))) {
        console.log(
          chalk.yellow(
            `  Insufficient ${quoteCurrency} balance (${available.toFixed(2)}) for split buy (${marketBuyQuote}). Skipping.`,
          ),
        );
      } else {
        console.log(
          chalk.dim(
            `  Placing market buy for ${marketBuyQuote} ${quoteCurrency}...`,
          ),
        );
        const orderResp = await this._client!.placeOrder({
          symbol: config.pair,
          side: "buy",
          market: { quoteSize: marketBuyQuote },
        });
        console.log(
          chalk.dim(
            `  Market buy placed: ${marketBuyQuote} ${quoteCurrency}. Waiting for fill...`,
          ),
        );
        const filledOrder = await this._awaitOrderFill(
          orderResp.data.venue_order_id,
        );
        const splitBaseAcquired = this._netBase(filledOrder);
        const splitFilledAmount = this._filledAmount(filledOrder, currentPrice);
        const splitFeeQuote = this._feeQuote(filledOrder, currentPrice);
        this._state.splitExecuted = true;
        this._addFee(splitFeeQuote);
        console.log(
          chalk.dim(
            `  Market buy filled: ${splitBaseAcquired} ${baseCurrency}` +
              (splitFeeQuote.gt(0)
                ? ` (fee ${splitFeeQuote.toFixed(2)} ${quoteCurrency})`
                : ""),
          ),
        );

        // Distribute acquired base across sell levels above current price
        const baseStep = this._getBaseStep();
        const sellLevels = this._state.levels.filter(
          (l) => new Decimal(l.price).gt(currentPrice) && !l.sellOrderId,
        );

        if (sellLevels.length > 0) {
          const basePerLevel = splitBaseAcquired
            .div(sellLevels.length)
            .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
          const costPerLevel = splitFilledAmount
            .plus(splitFeeQuote)
            .div(sellLevels.length);

          if (basePerLevel.gt(0)) {
            console.log(
              chalk.dim(
                `  Placing ${sellLevels.length} initial sell orders...`,
              ),
            );
            let sellsPlaced = 0;
            for (const sellLevel of sellLevels) {
              const buyLevel = this._state.levels[sellLevel.index - 1];
              if (buyLevel) {
                buyLevel.hasPosition = true;
                buyLevel.baseHeld = basePerLevel.toString();
                buyLevel.fillCost = costPerLevel.toFixed(2);
              }

              await this._placeSellOnLevel(sellLevel, basePerLevel);
              if (sellLevel.sellOrderId) {
                sellsPlaced++;
              } else if (buyLevel) {
                buyLevel.hasPosition = false;
                buyLevel.baseHeld = "0";
                buyLevel.fillCost = "0";
              }
              await sleep(ORDER_DELAY_MS);
            }
            console.log(
              chalk.dim(
                `  Sell orders placed: ${sellsPlaced}/${sellLevels.length}`,
              ),
            );
          }
        }
      }
    } else if (config.splitInvestment && this._state.splitExecuted) {
      console.log(
        chalk.dim(
          "  Split buy already executed in previous session — skipping.",
        ),
      );
    }

    // Phase 4: Save and summarize
    saveGridState(this._state);

    console.log(
      renderReconciliationSummary(
        buysFilled,
        sellsFilled,
        ordersKept,
        ordersDead,
      ),
    );
    console.log(chalk.dim("  Grid resumed and state saved.\n"));

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
    while (this._running) {
      const tickStart = performance.now();

      try {
        await this._tick();
        this._lastError = null;
      } catch (err) {
        if (err instanceof InsecureKeyPermissionsError) {
          console.log(
            chalk.red(
              `\n  Halting grid bot: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
          console.log(
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

      this._render();

      const elapsed = (performance.now() - tickStart) / 1000;
      const delay = Math.max(0, this._config.intervalSec - elapsed) * 1000;
      if (!this._running) break;
      await new Promise<void>((resolve) => {
        this._timer = setTimeout(() => {
          this._timer = null;
          resolve();
        }, delay);
      });
    }
  }

  private async _tick(): Promise<void> {
    const state = this._state!;
    const client = this._client!;
    this._warnings = [];
    this._connections = loadConnections().filter((c) => c.enabled);

    const currentPrice = await this._getMidPrice();
    this._previousPrice = this._currentPrice;
    this._currentPrice = currentPrice;

    if (this._config.stopLoss) {
      const stopLossPrice = new Decimal(this._config.stopLoss);
      if (currentPrice.lte(stopLossPrice)) {
        await this._triggerStopLoss(currentPrice);
        return;
      }
    }

    this._checkBoundary(currentPrice);

    if (this._config.dryRun) {
      await this._dryRunTick(currentPrice);
      this._tickCount++;
      if (this._shouldRebuildUp) {
        this._shouldRebuildUp = false;
        const hasOpenPositions = state.levels.some((l) => l.hasPosition);
        if (hasOpenPositions) {
          this._warnings.push(
            "Trailing up deferred: open positions present, will retry next tick",
          );
        } else {
          await this._rebuildGridUp(currentPrice);
        }
      }
      return;
    }

    // Fetch all active order IDs for this pair
    const activeOrderIds = new Set<string>();
    try {
      let cursor: string | undefined;
      do {
        const resp = await client.getActiveOrders({
          symbols: [this._config.pair],
          cursor,
          limit: 100,
        });
        for (const o of resp.data) {
          activeOrderIds.add(o.id);
        }
        cursor = resp.metadata?.next_cursor as string | undefined;
      } while (cursor);
    } catch (err) {
      throw new Error(
        `Failed to fetch active orders: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check each level's orders against active set
    for (const level of state.levels) {
      // --- Buy order gone from active set ---
      if (level.buyOrderId && !activeOrderIds.has(level.buyOrderId)) {
        try {
          const resp = await client.getOrder(level.buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const levelPrice = new Decimal(level.price);
            const netBase = this._netBase(order);
            const filledAmount = this._filledAmount(order, levelPrice);
            const feeQuote = this._feeQuote(order, levelPrice);
            level.hasPosition = true;
            level.baseHeld = netBase.toString();
            level.fillCost = filledAmount.plus(feeQuote).toString();
            level.buyOrderId = null;
            state.stats.totalBuys++;
            this._addFee(feeQuote);
            this._logTrade(
              "buy",
              level.price,
              netBase.toString(),
              order.id,
              undefined,
              feeQuote.toString(),
            );

            const base = this._config.pair.split("-")[0] ?? "";
            const cs = this._cs;
            const feeStr = feeQuote.gt(0)
              ? ` | fee ${cs}${feeQuote.toFixed(2)}`
              : "";
            this._notify(
              `Grid Bot ${this._config.pair}: BUY filled @ ${cs}${level.price} | ${netBase} ${base}${feeStr}`,
            );

            // Place sell on the level above
            const sellLevel = state.levels[level.index + 1];
            if (sellLevel) {
              await this._placeSellOnLevel(sellLevel, netBase);
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderId = null;
            await this._replaceGridBuy(level);
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          this._warnings.push(
            `Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
          );
        }
      }

      // --- Sell order gone from active set ---
      if (level.sellOrderId && !activeOrderIds.has(level.sellOrderId)) {
        try {
          const resp = await client.getOrder(level.sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const filledQty = new Decimal(order.filled_quantity);
            const sellPrice = new Decimal(level.price);
            const filledAmount = this._filledAmount(order, sellPrice);
            const feeQuote = this._feeQuote(order, sellPrice);

            const buyLevel = state.levels[level.index - 1];
            const costBasis =
              buyLevel?.fillCost && buyLevel.fillCost !== "0"
                ? new Decimal(buyLevel.fillCost)
                : new Decimal(state.quotePerLevel);
            const revenue = filledAmount.minus(feeQuote);
            const profit = revenue.minus(costBasis);

            level.sellOrderId = null;
            state.stats.totalSells++;
            this._addFee(feeQuote);
            state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
              .plus(profit)
              .toString();
            this._logTrade(
              "sell",
              sellPrice.toString(),
              filledQty.toString(),
              order.id,
              profit.toFixed(2),
              feeQuote.toString(),
            );

            const base = this._config.pair.split("-")[0] ?? "";
            const cs = this._cs;
            const feeStr = feeQuote.gt(0)
              ? ` | fee ${cs}${feeQuote.toFixed(2)}`
              : "";
            this._notify(
              `Grid Bot ${this._config.pair}: SELL filled @ ${cs}${sellPrice} | ` +
                `${filledQty} ${base} | profit ${cs}${profit.toFixed(2)}${feeStr} | ` +
                `total P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}`,
            );

            // Clear position on buy level (one below) and place buy back
            if (buyLevel) {
              buyLevel.hasPosition = false;
              buyLevel.baseHeld = "0";
              buyLevel.fillCost = "0";
              if (!buyLevel.buyOrderId) {
                try {
                  const orderId = await this._placeBuyOrder(
                    buyLevel,
                    new Decimal(state.quotePerLevel),
                  );
                  buyLevel.buyOrderId = orderId;
                } catch (err) {
                  rethrowIfInsecureKey(err);
                  this._warnings.push(
                    `Re-buy #${buyLevel.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.sellOrderId = null;
            const buyLevel = state.levels[level.index - 1];
            if (buyLevel?.hasPosition) {
              await this._placeSellOnLevel(
                level,
                new Decimal(buyLevel.baseHeld),
              );
            }
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
          !level.buyOrderId &&
          !level.sellOrderId &&
          !level.hasPosition &&
          new Decimal(level.price).lt(currentPrice)
        ) {
          await this._replaceGridBuy(level);
        }
      }
    }

    // HELD recovery: positions without a sell order on the level above
    for (const level of state.levels) {
      if (level.hasPosition) {
        const sellLevel = state.levels[level.index + 1];
        if (sellLevel && !sellLevel.sellOrderId) {
          const baseHeld = new Decimal(level.baseHeld);
          if (baseHeld.gt(0)) {
            await this._placeSellOnLevel(sellLevel, baseHeld);
          }
        }
      }
    }

    saveGridState(state);
    this._tickCount++;

    if (this._shouldRebuildUp) {
      this._shouldRebuildUp = false;
      const hasOpenPositions = state.levels.some((l) => l.hasPosition);
      if (hasOpenPositions) {
        this._warnings.push(
          "Trailing up deferred: open positions present, will retry next tick",
        );
      } else {
        await this._rebuildGridUp(currentPrice);
      }
    }
  }

  // --------------- dry run ---------------

  private async _dryRunTick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;

    for (const level of state.levels) {
      const levelPrice = new Decimal(level.price);

      // Simulate buy fill: price dropped below buy level
      if (level.buyOrderId && currentPrice.lt(levelPrice)) {
        const quotePerLevel = new Decimal(state.quotePerLevel);
        const baseStep = this._getBaseStep();
        const filledQty = quotePerLevel
          .div(levelPrice)
          .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

        level.hasPosition = true;
        level.baseHeld = filledQty.toString();
        level.fillCost = quotePerLevel.toString();
        level.buyOrderId = null;
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
          sellLevel.sellOrderId = `dry-sell-${sellLevel.index}`;
        }
      }

      // Simulate sell fill: price rose above this sell level
      if (level.sellOrderId && currentPrice.gt(levelPrice)) {
        const buyLevel = state.levels[level.index - 1];
        if (!buyLevel) continue;

        const filledQty = new Decimal(buyLevel.baseHeld);
        if (filledQty.lte(0)) continue;

        const sellPrice = levelPrice;
        const costBasis =
          buyLevel.fillCost && buyLevel.fillCost !== "0"
            ? new Decimal(buyLevel.fillCost)
            : new Decimal(state.quotePerLevel);
        const revenue = filledQty.times(sellPrice);
        const profit = revenue.minus(costBasis);

        level.sellOrderId = null;
        buyLevel.hasPosition = false;
        buyLevel.baseHeld = "0";
        buyLevel.fillCost = "0";
        state.stats.totalSells++;
        state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
          .plus(profit)
          .toString();
        this._logTrade(
          "sell",
          sellPrice.toString(),
          filledQty.toString(),
          `dry-${randomUUID().slice(0, 8)}`,
          profit.toFixed(2),
        );

        const base = this._config.pair.split("-")[0] ?? "";
        const cs = this._cs;
        this._notify(
          `Grid Bot ${this._config.pair}: SELL filled @ ${cs}${sellPrice} | ` +
            `${filledQty} ${base} | profit ${cs}${profit.toFixed(2)} | ` +
            `total P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)} [DRY RUN]`,
        );

        // Place buy back on the buy level
        if (!buyLevel.buyOrderId) {
          buyLevel.buyOrderId = `dry-buy-${buyLevel.index}`;
        }
      }
    }

    saveGridState(state);
  }

  // --------------- order placement ---------------

  /**
   * Place a sell order on the given level at its own price.
   * The base being sold belongs to the position on the level below.
   */
  private async _placeSellOnLevel(
    sellLevel: GridLevelState,
    baseAmount: Decimal,
  ): Promise<void> {
    if (baseAmount.lte(0)) return;

    if (sellLevel.sellOrderId) {
      this._warnings.push(
        `Sell @${sellLevel.price}: skipped – already has order ${sellLevel.sellOrderId}`,
      );
      return;
    }

    if (this._config.dryRun) {
      sellLevel.sellOrderId = `dry-sell-${sellLevel.index}`;
      return;
    }

    try {
      const resp = await this._client!.placeOrder({
        symbol: this._config.pair,
        side: "sell",
        limit: {
          price: sellLevel.price,
          baseSize: baseAmount.toString(),
          executionInstructions: ["post_only"],
        },
      });
      sellLevel.sellOrderId = resp.data.venue_order_id;
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
      const orderId = await this._placeBuyOrder(level, quotePerLevel);
      level.buyOrderId = orderId;
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
  ): Promise<string> {
    if (this._config.dryRun) {
      return `dry-buy-${level.index}`;
    }

    const resp = await this._client!.placeOrder({
      symbol: this._config.pair,
      side: "buy",
      limit: {
        price: level.price,
        quoteSize: quoteSize.toString(),
        executionInstructions: ["post_only"],
      },
    });
    return resp.data.venue_order_id;
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
    console.log(renderDashboard(data));
  }
}
