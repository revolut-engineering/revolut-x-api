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

export interface GridBotOptions {
  priceSource?: LivePriceSource;
  onTick?: (event: GridBotTickEvent) => void;
  suppressDashboard?: boolean;
}

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const ORDER_DELAY_MS = 200;
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
  private _priceSource: LivePriceSource | null = null;
  private _onTick: ((event: GridBotTickEvent) => void) | null = null;
  private _tradeLogStart = 0;
  private _suppressDashboard = false;
  private _statusReporter: LiveStatusReporter | null = null;
  private _lifecycle: "running" | "finished" | "stopped" = "running";

  constructor(config: GridBotConfig, options: GridBotOptions = {}) {
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
        `${activeConfig.levels} levels | ±${rangePctDisplay}% | ` +
        `${activeConfig.investment} ${this._state!.pair.split("-")[1] ?? ""}`,
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
      saveGridState(this._state!);
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
      for (const pos of level.positions) {
        if (pos.sellOrderId) {
          try {
            if (!this._config.dryRun) {
              await this._client.cancelOrder(pos.sellOrderId);
            }
            pos.sellOrderId = null;
            cancelled++;
          } catch {
            remaining++;
          }
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
    const ratio = upper.div(lower).pow(new Decimal(1).div(levels.length - 1));
    const cs = this._cs;

    if (
      this._config.trailingUp &&
      currentPrice.gte(
        upper
          .times(ratio)
          .plus(upper.times(ratio.pow(2)))
          .div(2),
      )
    ) {
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
    const N = state.levels.length;

    // Save per-level buy order counts before clearing (used for split mode)
    const savedCounts = state.levels.map((l) => l.buyOrderIds.length);

    if (!this._config.dryRun && client) {
      const cancels: Promise<void>[] = [];
      for (const level of state.levels) {
        for (const buyOrderId of level.buyOrderIds) {
          cancels.push(
            client
              .cancelOrder(buyOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
        for (const pos of level.positions) {
          if (pos.sellOrderId) {
            cancels.push(
              client
                .cancelOrder(pos.sellOrderId)
                .catch((err) => rethrowIfInsecureKey(err)),
            );
          }
        }
      }
      await Promise.all(cancels);
    }

    for (const level of state.levels) {
      level.buyOrderIds = [];
      level.positions = [];
    }

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

    for (let i = 0; i < N; i++) {
      state.levels[i].price = new Decimal(state.levels[i].price)
        .times(ratioK)
        .toDecimalPlaces(quoteStep.decimalPlaces(), Decimal.ROUND_DOWN)
        .toString();
    }

    state.gridPrice = currentPrice.toString();

    for (let i = 0; i < N; i++) {
      const level = state.levels[i];
      if (!new Decimal(level.price).lt(currentPrice)) continue;

      // split: restore savedCounts per level; no-split: exactly 1 buy per level below price
      const count = this._config.splitInvestment ? savedCounts[i] : 1;
      level.expectedBuys = count;

      for (let j = 0; j < count; j++) {
        try {
          const orderId = await this._placeBuyOrder(
            level,
            new Decimal(state.quotePerLevel),
          );
          level.buyOrderIds.push(orderId);
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
        for (const buyOrderId of level.buyOrderIds) {
          cancels.push(
            client
              .cancelOrder(buyOrderId)
              .catch((err) => rethrowIfInsecureKey(err)),
          );
        }
        for (const pos of level.positions) {
          if (pos.sellOrderId) {
            cancels.push(
              client
                .cancelOrder(pos.sellOrderId)
                .catch((err) => rethrowIfInsecureKey(err)),
            );
          }
        }
      }
      await Promise.all(cancels);
    }

    for (const level of state.levels) {
      level.buyOrderIds = [];
      for (const pos of level.positions) {
        pos.sellOrderId = null;
      }
    }

    // 2. Sell all accumulated base asset via market order
    const baseStep = this._getBaseStep();
    const allPositions = state.levels.flatMap((l) => l.positions);
    const totalBase = allPositions
      .filter((p) => new Decimal(p.baseHeld).gt(0))
      .reduce((sum, p) => sum.plus(p.baseHeld), new Decimal(0))
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
          const costBasis = allPositions
            .filter((p) => new Decimal(p.baseHeld).gt(0))
            .reduce(
              (sum, p) =>
                sum.plus(
                  p.fillCost && p.fillCost !== "0"
                    ? p.fillCost
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
      } else if (this._config.dryRun) {
        // Simulate the market sell in dry-run mode
        const costBasis = allPositions
          .filter((p) => new Decimal(p.baseHeld).gt(0))
          .reduce(
            (sum, p) =>
              sum.plus(
                p.fillCost && p.fillCost !== "0"
                  ? p.fillCost
                  : state.quotePerLevel,
              ),
            new Decimal(0),
          );
        const revenue = totalBase
          .times(currentPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        const pnl = revenue.minus(costBasis);
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
      }

      // Clear positions regardless of whether real sell succeeded
      for (const level of state.levels) {
        level.positions = [];
      }
    }

    this._notify(
      `Grid Bot ${state.pair}: STOP LOSS triggered at ${cs}${currentPrice.toFixed(2)}. ` +
        `Sold ${totalBase} base. Realized P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)}`,
    );

    this._lifecycle = "stopped";
    this._currentPrice = currentPrice;
    if (this._statusReporter) {
      await this._statusReporter.flush(this._renderStatusCard());
      state.statusMessages = this._statusReporter.snapshot();
    }
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
    const available = config.dryRun
      ? null
      : await this._checkBalance(quoteCurrency);

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
        buyOrderIds: [],
        positions: [],
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

    if (available !== null && available.lt(investment)) {
      const maxInvestment = available.toDecimalPlaces(2, Decimal.ROUND_DOWN);
      throw new Error(
        `Available ${quoteCurrency} balance (${available.toFixed(2)}) is less than ` +
          `the configured investment (${investment.toFixed(2)}). ` +
          `With ${totalCapitalLevels} capital level${totalCapitalLevels === 1 ? "" : "s"}, ` +
          `each level requires ${quotePerLevel.toFixed(2)} ${quoteCurrency}. ` +
          `Use --investment ${maxInvestment.toFixed(2)} to invest your full available balance, ` +
          `or deposit funds and retry.`,
      );
    }

    let splitExecuted = false;
    let splitBaseAcquired: Decimal | null = null;
    let splitFilledAmount: Decimal | null = null;
    let splitFeeQuote = new Decimal(0);
    if (config.splitInvestment && !config.dryRun) {
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

    // Log the split market buy so it appears in recent trades
    if (splitExecuted && splitBaseAcquired) {
      this._logTrade(
        "buy",
        currentPrice.toString(),
        splitBaseAcquired.toString(),
        "split-init",
      );
    } else if (
      config.splitInvestment &&
      config.dryRun &&
      sellLevelIndices.size > 0
    ) {
      const dryRunBase = quotePerLevel
        .times(sellLevelIndices.size)
        .div(currentPrice)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      this._logTrade(
        "buy",
        currentPrice.toString(),
        dryRunBase.toString(),
        "split-init",
      );
    }

    // --- Place initial buy orders ---
    const buyLevels = levels.filter((l) =>
      config.splitInvestment
        ? new Decimal(l.price).lte(currentPrice)
        : new Decimal(l.price).lt(currentPrice),
    );
    let buysPlaced = 0;
    const errors: string[] = [];
    console.log(
      chalk.dim(`  Placing ${buyLevels.length} initial buy orders...`),
    );
    for (const level of buyLevels) {
      try {
        const orderId = await this._placeBuyOrder(level, quotePerLevel);
        level.buyOrderIds.push(orderId);
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
          (errors.length > 0 ? chalk.yellow(` (${errors.length} failed)`) : ""),
      ),
    );

    // --- Place initial sell orders for split mode ---
    let sellsPlaced = 0;
    if (config.splitInvestment && sellLevelIndices.size > 0) {
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
            const pos: GridLevelPosition = {
              id: `split-${sellIdx}`,
              baseHeld: basePerLevel.toString(),
              fillCost: (costPerLevel ?? quotePerLevel).toFixed(2),
              sellOrderId: null,
            };
            buyLevel.positions.push(pos);
            await this._placeSellOnLevel(sellLevel, pos);
            if (pos.sellOrderId) {
              sellsPlaced++;
            } else {
              buyLevel.positions.pop();
            }
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

    // Check buy orders
    for (const level of this._state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (buyOrderId.startsWith("dry-")) {
          ordersKept++;
          continue;
        }
        try {
          const resp = await client.getOrder(buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            buysFilled++;
            const levelPrice = new Decimal(level.price);
            const netBase = this._netBase(order);
            const filledAmount = this._filledAmount(order, levelPrice);
            const feeQuote = this._feeQuote(order, levelPrice);
            level.positions.push({
              id: order.id,
              baseHeld: netBase.toString(),
              fillCost: filledAmount.plus(feeQuote).toString(),
              sellOrderId: null,
            });
            level.buyOrderIds = level.buyOrderIds.filter(
              (id) => id !== buyOrderId,
            );
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
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderIds = level.buyOrderIds.filter(
              (id) => id !== buyOrderId,
            );
            ordersDead++;
          } else {
            ordersKept++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          level.buyOrderIds = level.buyOrderIds.filter(
            (id) => id !== buyOrderId,
          );
          ordersDead++;
        }
        await sleep(ORDER_DELAY_MS);
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
          const resp = await client.getOrder(sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            sellsFilled++;
            const sellPrice = sellLevel
              ? new Decimal(sellLevel.price)
              : new Decimal(level.price);
            const filledQty = new Decimal(order.filled_quantity);
            const filledAmount = this._filledAmount(order, sellPrice);
            const feeQuote = this._feeQuote(order, sellPrice);
            const costBasis =
              pos.fillCost && pos.fillCost !== "0"
                ? new Decimal(pos.fillCost)
                : new Decimal(this._state.quotePerLevel);
            const profit = filledAmount.minus(feeQuote).minus(costBasis);

            level.positions = level.positions.filter((p) => p !== pos);
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
          } else if (DEAD_STATUSES.has(order.status)) {
            pos.sellOrderId = null;
            ordersDead++;
          } else {
            ordersKept++;
          }
        } catch (err) {
          rethrowIfInsecureKey(err);
          pos.sellOrderId = null;
          ordersDead++;
        }
        await sleep(ORDER_DELAY_MS);
      }
    }

    // Recalculate quotePerLevel if investment changed
    if (config.investment !== this._state.config.investment) {
      const midPrice = await this._getMidPrice();
      const totalActiveLevels = this._state.levels.filter(
        (l) =>
          l.buyOrderIds.length > 0 ||
          l.positions.length > 0 ||
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
        const sellLevels = this._state.levels.filter(
          (l) =>
            new Decimal(l.price).gt(currentPrice) &&
            !l.positions.some((p) => !!p.sellOrderId),
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
                const pos: GridLevelPosition = {
                  id: `split-reconcile-${sellLevel.index}`,
                  baseHeld: basePerLevel.toString(),
                  fillCost: costPerLevel.toFixed(2),
                  sellOrderId: null,
                };
                buyLevel.positions.push(pos);
                await this._placeSellOnLevel(sellLevel, pos);
                if (pos.sellOrderId) {
                  sellsPlaced++;
                } else {
                  buyLevel.positions.pop();
                }
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
    saveGridState(state);
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
    const body = [
      `${glyph} Grid ${state.pair}${mode}  ${label}`,
      `Price ${fmtPrice(price, cs)} · Pos ${position.toFixed()} ${base}`,
      `Realized ${fmtSignedPnl(realizedPnl, cs)} · Unreal ${fmtSignedPnl(unrealized, cs)}`,
      `Total ${fmtSignedPnl(totalPnl, cs)} · Net ${fmtMoney(netValue, cs)}`,
      `Fills ${s.totalBuys} buys · ${s.totalSells} sells · Up ${fmtUptime(Date.now() - this._startTime)}`,
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
        const hasOpenPositions = state.levels.some(
          (l) => l.positions.length > 0,
        );
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

    // Check each level's buy orders
    for (const level of state.levels) {
      for (const buyOrderId of [...level.buyOrderIds]) {
        if (activeOrderIds.has(buyOrderId)) continue;

        try {
          const resp = await client.getOrder(buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const levelPrice = new Decimal(level.price);
            const netBase = this._netBase(order);
            const filledAmount = this._filledAmount(order, levelPrice);
            const feeQuote = this._feeQuote(order, levelPrice);

            const pos: GridLevelPosition = {
              id: order.id,
              baseHeld: netBase.toString(),
              fillCost: filledAmount.plus(feeQuote).toString(),
              sellOrderId: null,
            };
            level.positions.push(pos);
            level.buyOrderIds = level.buyOrderIds.filter(
              (id) => id !== buyOrderId,
            );
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
              await this._placeSellOnLevel(sellLevel, pos);
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderIds = level.buyOrderIds.filter(
              (id) => id !== buyOrderId,
            );
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
          const resp = await client.getOrder(pos.sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const filledQty = new Decimal(order.filled_quantity);
            const sellPrice = new Decimal(sellLevel.price);
            const filledAmount = this._filledAmount(order, sellPrice);
            const feeQuote = this._feeQuote(order, sellPrice);
            const costBasis =
              pos.fillCost && pos.fillCost !== "0"
                ? new Decimal(pos.fillCost)
                : new Decimal(state.quotePerLevel);
            const revenue = filledAmount.minus(feeQuote);
            const profit = revenue.minus(costBasis);

            level.positions = level.positions.filter((p) => p !== pos);
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

            // Place buy back on this level — each sell independently redeploys
            // its capital as a new buy order (multi-slot: one rebuy per fill).
            try {
              const orderId = await this._placeBuyOrder(
                level,
                new Decimal(state.quotePerLevel),
              );
              level.buyOrderIds.push(orderId);
            } catch (err) {
              rethrowIfInsecureKey(err);
              this._warnings.push(
                `Re-buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            pos.sellOrderId = null;
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

    // Simulate buy fills — process all buy orders at each level
    for (const level of state.levels) {
      const levelPrice = new Decimal(level.price);

      for (const buyOrderId of [...level.buyOrderIds]) {
        // Buy limit order fills when market price <= order price
        if (!currentPrice.lte(levelPrice)) continue;

        const quotePerLevel = new Decimal(state.quotePerLevel);
        const baseStep = this._getBaseStep();
        const filledQty = quotePerLevel
          .div(levelPrice)
          .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

        const pos: GridLevelPosition = {
          id: `dry-${randomUUID().slice(0, 8)}`,
          baseHeld: filledQty.toString(),
          fillCost: quotePerLevel.toString(),
          sellOrderId: null,
        };
        level.positions.push(pos);
        level.buyOrderIds = level.buyOrderIds.filter((id) => id !== buyOrderId);
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
            `${filledQty} ${base} | profit ${cs}${profit.toFixed(2)} | ` +
            `total P&L: ${cs}${new Decimal(state.stats.realizedPnl).toFixed(2)} [DRY RUN]`,
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
    const baseAmount = new Decimal(position.baseHeld);
    if (baseAmount.lte(0)) return;

    if (position.sellOrderId) {
      this._warnings.push(
        `Sell: position already has order ${position.sellOrderId}`,
      );
      return;
    }

    if (this._config.dryRun) {
      position.sellOrderId = `dry-sell-${sellLevel.index}`;
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
      position.sellOrderId = resp.data.venue_order_id;
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
      level.buyOrderIds.push(orderId);
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
      return `dry-buy-${randomUUID().slice(0, 8)}`;
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
    console.log(renderDashboard(data));
  }
}
