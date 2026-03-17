import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { RevolutXClient } from "revolutx-api";
import type { CurrencyPair } from "revolutx-api";
import chalk from "chalk";
import {
  saveGridState,
  loadGridState,
  deleteGridState,
  type GridState,
  type GridLevelState,
  type GridTradeEntry,
} from "../db/grid-store.js";
import {
  renderDashboard,
  renderShutdownSummary,
  renderReconciliationSummary,
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
  private _boundaryAlerted = false;

  constructor(config: GridBotConfig) {
    this._config = config;
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
    this._client = new RevolutXClient();

    if (!this._client.isAuthenticated) {
      throw new Error(
        "API credentials not configured. Run 'revx configure' first.",
      );
    }

    await this._fetchPairInfo();
    const existingState = loadGridState(this._config.pair);

    if (existingState) {
      await this._reconcileAndInit(existingState);
    } else {
      await this._initNewGrid();
    }

    const activeConfig = this._state!.config;
    const rangePctDisplay = new Decimal(activeConfig.rangePct)
      .times(100)
      .toFixed(1);
    const modeLabel = activeConfig.dryRun ? " [DRY RUN]" : "";
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

    const gridPrice = new Decimal(state.gridPrice);
    const rangePct = new Decimal(state.config.rangePct);
    const lower = gridPrice.times(new Decimal(1).minus(rangePct));
    const upper = gridPrice.times(new Decimal(1).plus(rangePct));

    if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
      const direction = currentPrice.lt(lower) ? "below" : "above";
      const boundary = currentPrice.lt(lower) ? lower : upper;
      this._warnings.push(
        `Price ${direction} grid range ($${boundary.toFixed(2)})`,
      );
      if (!this._boundaryAlerted) {
        this._boundaryAlerted = true;
      }
    } else {
      this._boundaryAlerted = false;
    }
  }

  // --------------- initialization ---------------

  private async _initNewGrid(): Promise<void> {
    const config = this._config;

    console.log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getMidPrice();
    console.log(chalk.dim(`  Current mid-price: ${currentPrice}`));

    const quoteCurrency = config.pair.split("-")[1] ?? "";
    const investment = new Decimal(config.investment);
    if (!config.dryRun) {
      const available = await this._checkBalance(quoteCurrency);
      if (available !== null && available.lt(investment)) {
        console.log(
          chalk.yellow(
            `  Warning: Available ${quoteCurrency} balance (${available.toFixed(2)}) ` +
              `is less than investment (${investment.toFixed(2)}).`,
          ),
        );
      }
    }

    const minQuote = this._getMinOrderQuote();
    const minBase = this._getMinOrderBase();

    let splitExecuted = false;
    if (config.splitInvestment && !config.dryRun) {
      console.log(chalk.dim("  Placing market buy for 50% of investment..."));
      const halfInvestment = investment.div(2).toFixed(2);
      await this._client!.placeOrder({
        symbol: config.pair,
        side: "buy",
        market: { quoteSize: halfInvestment },
      });
      splitExecuted = true;
      console.log(
        chalk.dim(`  Market buy placed: ${halfInvestment} ${quoteCurrency}`),
      );
    }

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

    // Determine sell levels for split mode (above price, excluding top)
    const sellLevelIndices = new Set<number>();
    const positionLevelIndices = new Set<number>();
    if (config.splitInvestment) {
      for (const l of levels) {
        if (
          new Decimal(l.price).gte(currentPrice) &&
          l.index < config.levels - 1
        ) {
          sellLevelIndices.add(l.index);
          positionLevelIndices.add(l.index - 1);
        }
      }
    }

    // Count buy levels (below price and not holding a split position)
    let buyLevelCount = 0;
    for (const l of levels) {
      if (
        new Decimal(l.price).lt(currentPrice) &&
        !positionLevelIndices.has(l.index)
      ) {
        buyLevelCount++;
      }
    }

    const effectiveInvestment = config.splitInvestment
      ? investment.div(2)
      : investment;
    const effectiveBuyCount = config.splitInvestment
      ? buyLevelCount
      : levels.filter((l) => new Decimal(l.price).lt(currentPrice)).length;
    const quotePerLevel = effectiveInvestment
      .div(Math.max(effectiveBuyCount, 1))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

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
      },
      splitExecuted,
      gridPrice: currentPrice.toString(),
      quotePrecision: quoteStep.toString(),
      basePrecision: baseStep.toString(),
      quotePerLevel: quotePerLevel.toString(),
      levels,
      stats: {
        totalBuys: 0,
        totalSells: 0,
        realizedPnl: "0",
      },
      tradeLog: [],
    };

    // --- Place initial buy orders ---
    const buyLevels = levels.filter(
      (l) =>
        new Decimal(l.price).lt(currentPrice) &&
        !positionLevelIndices.has(l.index),
    );
    console.log(
      chalk.dim(`  Placing ${buyLevels.length} initial buy orders...`),
    );
    let buysPlaced = 0;
    const errors: string[] = [];
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
          (errors.length > 0 ? chalk.yellow(` (${errors.length} failed)`) : ""),
      ),
    );

    // --- Place initial sell orders for split mode ---
    let sellsPlaced = 0;
    if (config.splitInvestment && sellLevelIndices.size > 0) {
      const halfInvestment = investment.div(2);
      const totalBase = halfInvestment
        .div(currentPrice)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      const basePerLevel = totalBase
        .div(sellLevelIndices.size)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

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

          // Set position on the buy level (one below the sell)
          if (buyLevel) {
            buyLevel.hasPosition = true;
            buyLevel.baseHeld = basePerLevel.toString();
          }

          await this._placeSellOnLevel(sellLevel, basePerLevel);
          if (sellLevel.sellOrderId) {
            sellsPlaced++;
          } else if (buyLevel) {
            buyLevel.hasPosition = false;
            buyLevel.baseHeld = "0";
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

    console.log(
      chalk.dim("\n  Saved state found. Reconciling leftover orders..."),
    );

    // Phase 1: Check all saved orders against exchange
    const activeOrders: {
      orderId: string;
      side: "buy" | "sell";
      price: string;
    }[] = [];
    let buysFilled = 0;
    let sellsFilled = 0;
    let carryPnl = new Decimal(savedState.stats.realizedPnl);
    let carryBuys = savedState.stats.totalBuys;
    let carrySells = savedState.stats.totalSells;
    const carryLog: GridTradeEntry[] = [...savedState.tradeLog];

    for (const level of savedState.levels) {
      if (level.buyOrderId) {
        try {
          const resp = await client.getOrder(level.buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            buysFilled++;
            carryBuys++;
            carryLog.push({
              ts: new Date().toISOString(),
              side: "buy",
              price: level.price,
              quantity: order.filled_quantity,
              orderId: order.id,
            });
          } else if (!DEAD_STATUSES.has(order.status)) {
            activeOrders.push({
              orderId: level.buyOrderId,
              side: "buy",
              price: level.price,
            });
          }
        } catch {
          // Can't verify — treat as gone
        }
        await sleep(ORDER_DELAY_MS);
      }

      if (level.sellOrderId) {
        try {
          const resp = await client.getOrder(level.sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            sellsFilled++;
            carrySells++;
            const filledQty = new Decimal(order.filled_quantity);
            const sellPrice = new Decimal(level.price);
            const oldUsdPerLevel = new Decimal(savedState.quotePerLevel);
            const profit = filledQty.times(sellPrice).minus(oldUsdPerLevel);
            carryPnl = carryPnl.plus(profit);
            carryLog.push({
              ts: new Date().toISOString(),
              side: "sell",
              price: level.price,
              quantity: order.filled_quantity,
              orderId: order.id,
              profit: profit.toFixed(2),
            });
          } else if (!DEAD_STATUSES.has(order.status)) {
            activeOrders.push({
              orderId: level.sellOrderId,
              side: "sell",
              price: level.price,
            });
          }
        } catch {
          // Can't verify — treat as gone
        }
        await sleep(ORDER_DELAY_MS);
      }
    }

    // Phase 2: Compute new grid from current params
    console.log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getMidPrice();
    console.log(chalk.dim(`  Current mid-price: ${currentPrice}`));

    const quoteCurrency = config.pair.split("-")[1] ?? "";
    const investment = new Decimal(config.investment);
    if (!config.dryRun) {
      const available = await this._checkBalance(quoteCurrency);
      if (available !== null && available.lt(investment)) {
        console.log(
          chalk.yellow(
            `  Warning: Available ${quoteCurrency} balance (${available.toFixed(2)}) ` +
              `is less than investment (${investment.toFixed(2)}).`,
          ),
        );
      }
    }

    const minQuote = this._getMinOrderQuote();

    let splitExecuted = savedState.splitExecuted ?? false;
    if (config.splitInvestment && !config.dryRun && !splitExecuted) {
      console.log(chalk.dim("  Placing market buy for 50% of investment..."));
      const halfInvestment = investment.div(2).toFixed(2);
      await this._client!.placeOrder({
        symbol: config.pair,
        side: "buy",
        market: { quoteSize: halfInvestment },
      });
      splitExecuted = true;
      console.log(
        chalk.dim(`  Market buy placed: ${halfInvestment} ${quoteCurrency}`),
      );
    } else if (config.splitInvestment && splitExecuted) {
      console.log(
        chalk.dim(
          "  Split buy already executed in previous session — skipping.",
        ),
      );
    }

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

    const sellLevelIndices = new Set<number>();
    const positionLevelIndices = new Set<number>();
    if (config.splitInvestment) {
      for (const l of levels) {
        if (
          new Decimal(l.price).gte(currentPrice) &&
          l.index < config.levels - 1
        ) {
          sellLevelIndices.add(l.index);
          positionLevelIndices.add(l.index - 1);
        }
      }
    }

    let buyLevelCount = 0;
    for (const l of levels) {
      if (
        new Decimal(l.price).lt(currentPrice) &&
        !positionLevelIndices.has(l.index)
      ) {
        buyLevelCount++;
      }
    }

    const effectiveInvestment = config.splitInvestment
      ? investment.div(2)
      : investment;
    const effectiveBuyCount = config.splitInvestment
      ? buyLevelCount
      : levels.filter((l) => new Decimal(l.price).lt(currentPrice)).length;
    const quotePerLevel = effectiveInvestment
      .div(Math.max(effectiveBuyCount, 1))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    if (minQuote.gt(0) && quotePerLevel.lt(minQuote)) {
      console.log(
        chalk.yellow(
          `  Warning: Quote per level (${quotePerLevel}) is below min order size (${minQuote}). Orders may be rejected.`,
        ),
      );
    }

    // Phase 3: Match active leftover buy orders to new grid levels
    const priceToLevel = new Map<string, GridLevelState>();
    for (const lv of levels) {
      priceToLevel.set(lv.price, lv);
    }

    let adopted = 0;
    let cancelledLeftovers = 0;

    for (const leftover of activeOrders) {
      const matchLevel = priceToLevel.get(leftover.price);
      if (
        leftover.side === "buy" &&
        matchLevel &&
        !matchLevel.buyOrderId &&
        new Decimal(matchLevel.price).lt(currentPrice) &&
        !positionLevelIndices.has(matchLevel.index)
      ) {
        matchLevel.buyOrderId = leftover.orderId;
        adopted++;
      } else {
        try {
          if (!config.dryRun) {
            await client.cancelOrder(leftover.orderId);
          }
          cancelledLeftovers++;
        } catch {
          // Already gone
        }
        await sleep(ORDER_DELAY_MS);
      }
    }

    // Phase 4: Place new buy orders on uncovered levels
    const uncoveredBuyLevels = levels.filter(
      (l) =>
        new Decimal(l.price).lt(currentPrice) &&
        !positionLevelIndices.has(l.index) &&
        !l.buyOrderId,
    );

    console.log(
      chalk.dim(
        `  Placing ${uncoveredBuyLevels.length} buy orders` +
          (adopted > 0 ? ` (${adopted} adopted from previous session)` : "") +
          "...",
      ),
    );

    let buysPlaced = 0;
    const errors: string[] = [];
    for (const level of uncoveredBuyLevels) {
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

    const totalBuyLevels = uncoveredBuyLevels.length + adopted;
    if (buysPlaced === 0 && uncoveredBuyLevels.length > 0 && adopted === 0) {
      const detail = errors.length > 0 ? `\n  First error: ${errors[0]}` : "";
      throw new Error(
        `Failed to place any buy orders (0/${uncoveredBuyLevels.length}).${detail}`,
      );
    }

    console.log(
      chalk.dim(
        `  Buy orders: ${buysPlaced + adopted}/${totalBuyLevels}` +
          (adopted > 0 ? ` (${adopted} reused)` : "") +
          (errors.length > 0 ? chalk.yellow(` (${errors.length} failed)`) : ""),
      ),
    );

    // Phase 5: Place sell orders for split mode
    let sellsPlaced = 0;
    if (config.splitInvestment && sellLevelIndices.size > 0) {
      const halfInvestment = investment.div(2);
      const totalBase = halfInvestment
        .div(currentPrice)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
      const basePerLevel = totalBase
        .div(sellLevelIndices.size)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

      if (basePerLevel.gt(0)) {
        const minBase = this._getMinOrderBase();
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
          }

          await this._placeSellOnLevel(sellLevel, basePerLevel);
          if (sellLevel.sellOrderId) {
            sellsPlaced++;
          } else if (buyLevel) {
            buyLevel.hasPosition = false;
            buyLevel.baseHeld = "0";
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

    // Phase 6: Build and save new state
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
      },
      splitExecuted,
      gridPrice: currentPrice.toString(),
      quotePrecision: quoteStep.toString(),
      basePrecision: baseStep.toString(),
      quotePerLevel: quotePerLevel.toString(),
      levels,
      stats: {
        totalBuys: carryBuys,
        totalSells: carrySells,
        realizedPnl: carryPnl.toString(),
      },
      tradeLog: carryLog,
    };

    saveGridState(this._state);

    if (errors.length > 0) {
      this._warnings = errors.slice(0, 3).map((e) => `Order failed: ${e}`);
    }

    console.log(
      renderReconciliationSummary(
        buysFilled,
        sellsFilled,
        adopted,
        cancelledLeftovers,
      ),
    );
    console.log(chalk.dim("  Grid initialized and state saved.\n"));

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

    const currentPrice = await this._getMidPrice();
    this._previousPrice = this._currentPrice;
    this._currentPrice = currentPrice;

    this._checkBoundary(currentPrice);

    if (this._config.dryRun) {
      await this._dryRunTick(currentPrice);
      this._tickCount++;
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
            const filledQty = new Decimal(order.filled_quantity);
            level.hasPosition = true;
            level.baseHeld = filledQty.toString();
            level.fillCost = new Decimal(state.quotePerLevel).toString();
            level.buyOrderId = null;
            state.stats.totalBuys++;
            this._logTrade("buy", level.price, filledQty.toString(), order.id);

            // Place sell on the level above
            const sellLevel = state.levels[level.index + 1];
            if (sellLevel) {
              await this._placeSellOnLevel(sellLevel, filledQty);
            }

          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderId = null;
            await this._replaceGridBuy(level);
          }
        } catch (err) {
          level.buyOrderId = null;
          this._warnings.push(
            `Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
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

            const quotePerLevel = new Decimal(state.quotePerLevel);
            const revenue = filledQty.times(sellPrice);
            const profit = revenue.minus(quotePerLevel);

            level.sellOrderId = null;
            state.stats.totalSells++;
            state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
              .plus(profit)
              .toString();
            this._logTrade(
              "sell",
              sellPrice.toString(),
              filledQty.toString(),
              order.id,
              profit.toFixed(2),
            );

            // Clear position on buy level (one below) and place buy back
            const buyLevel = state.levels[level.index - 1];
            if (buyLevel) {
              buyLevel.hasPosition = false;
              buyLevel.baseHeld = "0";
              buyLevel.fillCost = "0";
              try {
                const orderId = await this._placeBuyOrder(
                  buyLevel,
                  quotePerLevel,
                );
                buyLevel.buyOrderId = orderId;
              } catch (err) {
                this._warnings.push(
                  `Re-buy #${buyLevel.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
                );
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
          level.sellOrderId = null;
          this._warnings.push(
            `Check sell #${level.index + 1}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Orphan recovery: empty levels below price get buy orders
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
        const quotePerLevel = new Decimal(state.quotePerLevel);
        const revenue = filledQty.times(sellPrice);
        const profit = revenue.minus(quotePerLevel);

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

        // Place buy back on the buy level
        buyLevel.buyOrderId = `dry-buy-${buyLevel.index}`;
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

  private _logTrade(
    side: "buy" | "sell",
    price: string,
    quantity: string,
    orderId: string,
    profit?: string,
  ): void {
    const entry: GridTradeEntry = {
      ts: new Date().toISOString(),
      side,
      price,
      quantity,
      orderId,
    };
    if (profit !== undefined) entry.profit = profit;
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
      intervalSec: this._config.intervalSec,
    };

    process.stdout.write("\x1B[2J\x1B[H");
    console.log(renderDashboard(data));
  }
}
