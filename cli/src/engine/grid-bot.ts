import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { RevolutXClient } from "revolutx-api";
import type { CurrencyPair } from "revolutx-api";
import chalk from "chalk";
import {
  saveGridState,
  loadGridState,
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
  resume: boolean;
}

const FILLED_STATUSES = new Set(["filled"]);
const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);

export class ForegroundGridBot {
  private _config: GridBotConfig;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _client: RevolutXClient | null = null;
  private _state: GridState | null = null;
  private _startTime = 0;
  private _prevPrice: Decimal | null = null;
  private _tickCount = 0;
  private _lastError: string | null = null;
  private _pairInfo: CurrencyPair | null = null;
  private _connections: TelegramConnection[] = [];

  constructor(config: GridBotConfig) {
    this._config = config;
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
    this._client = new RevolutXClient();
    this._connections = loadConnections().filter((c) => c.enabled);

    if (!this._client.isAuthenticated) {
      throw new Error(
        "API credentials not configured. Run 'revx configure' first.",
      );
    }

    await this._fetchPairInfo();
    const existingState = loadGridState(this._config.pair);

    if (existingState && this._config.resume) {
      this._state = existingState;
      console.log(chalk.dim("\n  Resuming grid bot from saved state..."));
      await this._reconcile();
    } else if (existingState && !this._config.resume) {
      console.log(
        chalk.yellow(
          `\n  Warning: Existing state found for ${this._config.pair}. Use --resume to continue, or this will create a new grid.`,
        ),
      );
      await this._initNewGrid();
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
        `${activeConfig.investment} USD`,
    );

    await this._loop();
  }

  async shutdown(): Promise<void> {
    if (!this._state || !this._client) return;

    console.log(chalk.dim("\n  Cancelling open orders..."));
    let cancelled = 0;
    for (const level of this._state.levels) {
      if (level.buyOrderId) {
        try {
          if (!this._config.dryRun) {
            await this._client.cancelOrder(level.buyOrderId);
          }
          level.buyOrderId = null;
          cancelled++;
        } catch {
          // order may already be filled/cancelled
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
          // order may already be filled/cancelled
        }
      }
    }

    saveGridState(this._state);

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

    console.log(renderShutdownSummary(this._state, currentPrice));

    const s = this._state.stats;
    this._notify(
      `Grid Bot stopped: ${this._state.pair} | ` +
        `${s.totalBuys} buys, ${s.totalSells} sells | ` +
        `P&L: $${new Decimal(s.realizedPnl).toFixed(2)}`,
    );
  }

  private async _fetchPairInfo(): Promise<void> {
    const client = this._client!;
    try {
      const pairs = await client.getCurrencyPairs();
      const slashPair = this._config.pair.replace("-", "/");
      this._pairInfo = pairs[slashPair] ?? null;
    } catch {
      this._pairInfo = null;
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

  private async _getMidPrice(): Promise<Decimal> {
    const client = this._client!;
    const resp = await client.getOrderBook(this._config.pair, { limit: 1 });
    const bestBid = resp.data.bids[0];
    const bestAsk = resp.data.asks[0];
    if (!bestBid || !bestAsk) {
      throw new Error(`No order book data for ${this._config.pair}`);
    }
    return new Decimal(bestBid.p).plus(new Decimal(bestAsk.p)).div(2);
  }

  private async _initNewGrid(): Promise<void> {
    const client = this._client!;
    const config = this._config;

    console.log(chalk.dim("  Fetching current price..."));
    const currentPrice = await this._getMidPrice();
    console.log(chalk.dim(`  Current mid-price: ${currentPrice}`));

    if (config.splitInvestment && !config.dryRun) {
      console.log(chalk.dim("  Placing market buy for 50% of investment..."));
      const halfInvestment = new Decimal(config.investment).div(2).toFixed(2);
      await client.placeOrder({
        symbol: config.pair,
        side: "buy",
        market: { quoteSize: halfInvestment },
      });
      console.log(chalk.dim(`  Market buy placed: ${halfInvestment} USD`));
    }

    const rangePct = new Decimal(config.rangePct);
    const lower = currentPrice.times(new Decimal(1).minus(rangePct));
    const upper = currentPrice.times(new Decimal(1).plus(rangePct));
    const step = upper.minus(lower).div(config.levels - 1);
    const quoteStep = this._getQuoteStep();
    const baseStep = this._getBaseStep();

    const levels: GridLevelState[] = [];
    let buyLevelCount = 0;
    for (let i = 0; i < config.levels; i++) {
      const rawPrice = lower.plus(step.times(i));
      const price = rawPrice.toDecimalPlaces(
        quoteStep.decimalPlaces(),
        Decimal.ROUND_DOWN,
      );
      const isBuyLevel = price.lt(currentPrice);
      if (isBuyLevel) buyLevelCount++;
      levels.push({
        index: i,
        price: price.toString(),
        buyOrderId: null,
        sellOrderId: null,
        hasPosition: false,
        baseHeld: "0",
      });
    }

    const investment = new Decimal(config.investment);
    const effectiveInvestment = config.splitInvestment
      ? investment.div(2)
      : investment;
    const usdPerLevel = effectiveInvestment
      .div(Math.max(buyLevelCount, 1))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    const strategyId = randomUUID().slice(0, 8);
    this._state = {
      id: strategyId,
      pair: config.pair,
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
      gridPrice: currentPrice.toString(),
      quotePrecision: quoteStep.toString(),
      basePrecision: baseStep.toString(),
      usdPerLevel: usdPerLevel.toString(),
      levels,
      stats: {
        totalBuys: 0,
        totalSells: 0,
        realizedPnl: "0",
      },
      tradeLog: [],
    };

    console.log(chalk.dim(`  Placing ${buyLevelCount} initial buy orders...`));
    for (const level of levels) {
      const levelPrice = new Decimal(level.price);
      if (!levelPrice.lt(currentPrice)) continue;

      const baseSize = usdPerLevel
        .div(levelPrice)
        .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

      if (baseSize.lte(0)) continue;

      try {
        const orderId = await this._placeBuyOrder(level, baseSize);
        level.buyOrderId = orderId;
      } catch (err) {
        console.log(
          chalk.yellow(
            `  Warning: Failed to place buy at ${level.price}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    saveGridState(this._state);
    console.log(chalk.dim("  Grid initialized and state saved.\n"));
  }

  private async _reconcile(): Promise<void> {
    const state = this._state!;
    const client = this._client!;
    let buysFilled = 0;
    let sellsFilled = 0;
    let buysReplaced = 0;
    let sellsReplaced = 0;

    for (const level of state.levels) {
      if (level.buyOrderId) {
        try {
          const resp = await client.getOrder(level.buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            buysFilled++;
            const filledQty = new Decimal(order.filled_quantity);
            level.hasPosition = true;
            level.baseHeld = filledQty.toString();
            level.buyOrderId = null;
            state.stats.totalBuys++;
            this._logTrade("buy", level.price, filledQty.toString(), order.id);
            await this._placeSellForLevel(level);
          } else if (DEAD_STATUSES.has(order.status)) {
            buysReplaced++;
            level.buyOrderId = null;
            await this._replaceGridBuy(level);
          }
          // 'new' or 'partially_filled' -> keep as-is
        } catch {
          level.buyOrderId = null;
          buysReplaced++;
          await this._replaceGridBuy(level);
        }
      }

      if (level.sellOrderId) {
        try {
          const resp = await client.getOrder(level.sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            sellsFilled++;
            const filledQty = new Decimal(order.filled_quantity);
            const sellPrice = new Decimal(level.price);
            const nextLevel = state.levels[level.index + 1];
            const actualSellPrice = nextLevel
              ? new Decimal(nextLevel.price)
              : sellPrice;

            const usdPerLevel = new Decimal(state.usdPerLevel);
            const revenue = filledQty.times(actualSellPrice);
            const profit = revenue.minus(usdPerLevel);

            level.hasPosition = false;
            level.baseHeld = "0";
            level.sellOrderId = null;
            state.stats.totalSells++;
            state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
              .plus(profit)
              .toString();
            this._logTrade(
              "sell",
              actualSellPrice.toString(),
              filledQty.toString(),
              order.id,
              profit.toFixed(2),
            );
            await this._replaceGridBuy(level);
          } else if (DEAD_STATUSES.has(order.status)) {
            sellsReplaced++;
            level.sellOrderId = null;
            if (level.hasPosition) {
              await this._placeSellForLevel(level);
            }
          }
        } catch {
          level.sellOrderId = null;
          sellsReplaced++;
          if (level.hasPosition) {
            await this._placeSellForLevel(level);
          }
        }
      }
    }

    saveGridState(state);
    console.log(
      renderReconciliationSummary(
        buysFilled,
        sellsFilled,
        buysReplaced,
        sellsReplaced,
      ),
    );

    if (buysFilled + sellsFilled > 0) {
      const parts: string[] = [`Grid Bot resumed: ${state.pair}`];
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

    const currentPrice = await this._getMidPrice();
    const baseStep = this._getBaseStep();

    if (this._config.dryRun) {
      await this._dryRunTick(currentPrice);
      this._prevPrice = currentPrice;
      this._tickCount++;
      return;
    }

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
    } catch {
      // if fetching active orders fails, skip this tick
      return;
    }

    for (const level of state.levels) {
      if (level.buyOrderId && !activeOrderIds.has(level.buyOrderId)) {
        try {
          const resp = await client.getOrder(level.buyOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const filledQty = new Decimal(order.filled_quantity);
            level.hasPosition = true;
            level.baseHeld = filledQty.toString();
            level.buyOrderId = null;
            state.stats.totalBuys++;
            this._logTrade("buy", level.price, filledQty.toString(), order.id);
            await this._placeSellForLevel(level);
            const base = this._config.pair.split("-")[0] ?? "";
            this._notify(
              `Grid Bot ${this._config.pair}: BUY filled @ $${level.price} | ${filledQty} ${base}`,
            );
          } else if (DEAD_STATUSES.has(order.status)) {
            level.buyOrderId = null;
            await this._replaceGridBuy(level);
          }
        } catch {
          level.buyOrderId = null;
        }
      }

      if (level.sellOrderId && !activeOrderIds.has(level.sellOrderId)) {
        try {
          const resp = await client.getOrder(level.sellOrderId);
          const order = resp.data;
          if (FILLED_STATUSES.has(order.status)) {
            const filledQty = new Decimal(order.filled_quantity);
            const nextLevel = state.levels[level.index + 1];
            const sellPrice = nextLevel
              ? new Decimal(nextLevel.price)
              : new Decimal(level.price);

            const usdPerLevel = new Decimal(state.usdPerLevel);
            const revenue = filledQty.times(sellPrice);
            const profit = revenue.minus(usdPerLevel);

            level.hasPosition = false;
            level.baseHeld = "0";
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

            const base = this._config.pair.split("-")[0] ?? "";
            this._notify(
              `Grid Bot ${this._config.pair}: SELL filled @ $${sellPrice} | ` +
                `${filledQty} ${base} | profit $${profit.toFixed(2)}`,
            );

            const buyBaseSize = usdPerLevel
              .div(new Decimal(level.price))
              .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);
            if (buyBaseSize.gt(0)) {
              try {
                const orderId = await this._placeBuyOrder(level, buyBaseSize);
                level.buyOrderId = orderId;
              } catch {
                // will recover via orphan sweep below
              }
            }
          } else if (DEAD_STATUSES.has(order.status)) {
            level.sellOrderId = null;
            if (level.hasPosition) {
              await this._placeSellForLevel(level);
            }
          }
        } catch {
          level.sellOrderId = null;
        }
      }
    }

    for (const level of state.levels) {
      if (!level.buyOrderId && !level.sellOrderId && !level.hasPosition) {
        await this._replaceGridBuy(level);
      }
    }

    saveGridState(state);
    this._prevPrice = currentPrice;
    this._tickCount++;
  }

  private async _dryRunTick(currentPrice: Decimal): Promise<void> {
    const state = this._state!;

    for (const level of state.levels) {
      const levelPrice = new Decimal(level.price);

      if (level.buyOrderId && currentPrice.lte(levelPrice)) {
        const usdPerLevel = new Decimal(state.usdPerLevel);
        const baseStep = this._getBaseStep();
        const filledQty = usdPerLevel
          .div(levelPrice)
          .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

        level.hasPosition = true;
        level.baseHeld = filledQty.toString();
        level.buyOrderId = null;
        state.stats.totalBuys++;
        this._logTrade(
          "buy",
          level.price,
          filledQty.toString(),
          `dry-${randomUUID().slice(0, 8)}`,
        );

        const nextLevel = state.levels[level.index + 1];
        if (nextLevel) {
          level.sellOrderId = `dry-sell-${level.index}`;
        }
      }

      if (level.sellOrderId && level.hasPosition) {
        const nextLevel = state.levels[level.index + 1];
        if (nextLevel && currentPrice.gte(new Decimal(nextLevel.price))) {
          const filledQty = new Decimal(level.baseHeld);
          const sellPrice = new Decimal(nextLevel.price);
          const usdPerLevel = new Decimal(state.usdPerLevel);
          const revenue = filledQty.times(sellPrice);
          const profit = revenue.minus(usdPerLevel);

          level.hasPosition = false;
          level.baseHeld = "0";
          level.sellOrderId = null;
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

          level.buyOrderId = `dry-buy-${level.index}`;
        }
      }
    }

    saveGridState(state);
  }

  private async _placeSellForLevel(level: GridLevelState): Promise<void> {
    const state = this._state!;
    const nextLevel = state.levels[level.index + 1];
    if (!nextLevel) return;

    const baseHeld = new Decimal(level.baseHeld);
    if (baseHeld.lte(0)) return;

    if (this._config.dryRun) {
      level.sellOrderId = `dry-sell-${level.index}`;
      return;
    }

    const sellPrice = nextLevel.price;
    const clientOrderId = `grid-${state.id}-${level.index}-sell-${randomUUID().slice(0, 8)}`;

    try {
      const resp = await this._client!.placeOrder({
        symbol: this._config.pair,
        side: "sell",
        limit: {
          price: sellPrice,
          baseSize: baseHeld.toString(),
          executionInstructions: ["post_only"],
        },
        clientOrderId,
      });
      level.sellOrderId = resp.data.venue_order_id;
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Warning: Failed to place sell at ${sellPrice}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  private async _replaceGridBuy(level: GridLevelState): Promise<void> {
    const state = this._state!;
    const usdPerLevel = new Decimal(state.usdPerLevel);
    const levelPrice = new Decimal(level.price);
    const baseStep = this._getBaseStep();

    const baseSize = usdPerLevel
      .div(levelPrice)
      .toDecimalPlaces(baseStep.decimalPlaces(), Decimal.ROUND_DOWN);

    if (baseSize.lte(0)) return;

    try {
      const orderId = await this._placeBuyOrder(level, baseSize);
      level.buyOrderId = orderId;
    } catch {
      // will retry next tick
    }
  }

  private async _placeBuyOrder(
    level: GridLevelState,
    baseSize: Decimal,
  ): Promise<string> {
    const state = this._state!;

    if (this._config.dryRun) {
      return `dry-buy-${level.index}`;
    }

    const clientOrderId = `grid-${state.id}-${level.index}-buy-${randomUUID().slice(0, 8)}`;
    const resp = await this._client!.placeOrder({
      symbol: this._config.pair,
      side: "buy",
      limit: {
        price: level.price,
        baseSize: baseSize.toString(),
        executionInstructions: ["post_only"],
      },
      clientOrderId,
    });
    return resp.data.venue_order_id;
  }

  private _notify(message: string): void {
    if (this._connections.length === 0) return;
    for (const tc of this._connections) {
      void sendWithRetries(tc.bot_token, tc.chat_id, message);
    }
  }

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

  private _render(): void {
    if (!this._state) return;

    let currentPrice: Decimal;
    try {
      currentPrice = this._prevPrice ?? new Decimal(this._state.gridPrice);
    } catch {
      currentPrice = new Decimal(this._state.gridPrice);
    }

    const data: DashboardData = {
      state: this._state,
      currentPrice,
      previousPrice: this._tickCount > 1 ? this._prevPrice : null,
      uptime: Date.now() - this._startTime,
      tickCount: this._tickCount,
      lastError: this._lastError,
      telegramConnections: this._connections.length,
    };

    process.stdout.write("\x1B[2J\x1B[H");
    console.log(renderDashboard(data));
  }
}
