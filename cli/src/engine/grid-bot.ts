import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import {
  RevolutXClient,
  InsecureKeyPermissionsError,
  isDuplicateClientOrderIdError,
  NotFoundError,
  paginateWithDynamicWindows,
  HISTORICAL_ORDERS_API_LIMIT,
} from "@revolut/revolut-x-api";
import type {
  CurrencyPair,
  Order,
  OrderDetails,
  OrderPlacementResult,
  PlaceOrderParams,
} from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";
import chalk from "chalk";
import type { LivePriceSource } from "../shared/price-source/index.js";
import {
  StablePriceTracker,
  TickerPriceProvider,
  withCachedPeek,
} from "../shared/price-source/index.js";
import {
  GridStateDamagedError,
  saveGridState,
  loadGridState,
  deleteGridState,
  setAsideGridState,
  type GridState,
  type GridLevelState,
  type GridLevelPosition,
  type GridTradeEntry,
  type GridHaltReason,
} from "../db/grid-store.js";
import {
  awaitTerminal,
  cancelUntilClosed,
  DEAD_STATUSES,
  FILLED_STATUSES,
  outsideChange,
  type CancelOutcome,
  type OrderGateway,
} from "./order-gateway.js";
import { PlacementHealth } from "./placement-health.js";
import {
  OutageWatch,
  exchangeFault,
  refusalOf,
  type OutageAlert,
} from "./outage-watch.js";
import {
  noDataMessage,
  recoveryMessage,
  refusedKeyMessage,
  refusedKeyNotice,
  savedKeyLabel,
} from "./exchange-alerts.js";
import { placementDoubt, retryFailure } from "../util/order-outcome.js";
import { loadConnections, type TelegramConnection } from "../db/store.js";
import { sendWithRetries, type TelegramResult } from "./notify.js";
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
  untrackedReplacementsNote,
  type ClosedPendingOrder,
  type DashboardData,
} from "./grid-renderer.js";
import {
  TAKER_FEE_RATE,
  levelsPerSide,
  trailUpTriggerPrice,
} from "./grid-math.js";
import {
  allocateBaseOrderSizes,
  ceilToStep,
  constraintsFromPair,
  createGridPlan,
  createTrailingGridRebuildPlan,
  floorToStep,
  normalizeBaseOrderSize,
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
  place<T>(
    operation: () => Promise<T>,
    refuse?: () => Error | null,
  ): Promise<T>;
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
  trailingUpConfirmationTicks?: number;
}

interface TrackedOrder {
  level: GridLevelState;
  orderId: string;
  position?: GridLevelPosition;
}

interface PendingIntent {
  clientOrderId: string;
  level: GridLevelState;
  position?: GridLevelPosition;
}

type CloseOut =
  | { outcome: "complete" | "failed" }
  | { outcome: "waiting"; reason: string };
type SaleOutcome =
  | { outcome: "sold"; filled: Decimal }
  | Exclude<CloseOut, { outcome: "complete" }>;

const STOPPED_BEFORE_SALE = "Stopped by Ctrl+C before the next sale.";

interface ResumedPlacement {
  orderId: string;
  closedAs: ClosedPendingOrder | null;
}

function placedAgain(
  orderId: string | null,
  closedAs: ClosedPendingOrder | null,
): ResumedPlacement | null {
  return orderId ? { orderId, closedAs } : null;
}

interface GridOrdersClosed {
  cancelled: number;
  problems: string[];
  unlisted: string[];
}

type UnlistedPlan =
  | { action: "wait" }
  | { action: "resend"; clientOrderId: string }
  | { action: "replace" };

interface PositionSettlement {
  quantity: Decimal;
  feeQuote: Decimal;
  profit: Decimal;
  costBasis: Decimal;
  remainingBase: Decimal;
  rebuyQuote: Decimal;
}

const RESTING_STATUSES = new Set(["new", "partially_filled"]);
const PARTIALLY_FILLED_STATUS = "partially_filled";
const CANCELLED_STATUSES = new Set(["cancelled", PARTIALLY_FILLED_STATUS]);
const LADDER_MAX_ROWS = 80;
const MAX_REJECTIONS = 3;
const MAX_EMPTY_SALES = 3;
const UNCONFIRMED_GRACE_MS = 5 * 60_000;
const SELL_OFF_RETRY_MS = 30_000;
const SELL_OFF_WAIT_LIMIT_MS = UNCONFIRMED_GRACE_MS + 60_000;
const AWAITING_LOOKUP = "not confirmed yet, looked up once a minute";
const REJECTED_LOOKUP = "rejected or already placed, looked up once a minute";
const NOT_LISTED_YET = "not listed by the exchange yet";
const NOT_PLACED_YET = "not placed yet";
const UNLISTED_WITHOUT_ID =
  "not listed by the exchange, client order ID unknown, not sent again";
const UNLISTED_NOTICE_MS = 60_000;
const UNIDENTIFIED_HOLD_MS = 24 * 60 * 60 * 1000;
const HISTORY_RETRY_MS = 60_000;
const PENDING_LOOKUP_MS = 60_000;
const ORDER_LOOKUP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ORDER_LOOKUP_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;
const TRAILING_UP_CONFIRMATION_TICKS = 3;

interface SellOffSummary {
  soldBase: Decimal;
  soldQuote: Decimal;
  unpricedFill: boolean;
  writtenOff: Decimal;
  cancelled: number;
}

class OrderRejectedError extends Error {
  constructor(
    readonly side: "buy" | "sell",
    readonly price: string,
    readonly reason: string,
  ) {
    super(`${side === "buy" ? "Buy" : "Sell"} order at ${price} ${reason}.`);
    this.name = "OrderRejectedError";
  }
}

class OrderNotSentError extends Error {
  constructor() {
    super("The order was not sent because the grid is stopping.");
    this.name = "OrderNotSentError";
  }
}

function unlistedCancelProblem(orderId: string): string {
  return `Order ${orderId} isn't listed by the exchange yet, so its cancel can't be confirmed. Start again in a few minutes.`;
}

function describeProblems(problems: string[]): string {
  const others = problems.length - 1;
  return others === 0
    ? problems[0]
    : `${problems[0]} ${others} more order${others === 1 ? "" : "s"} didn't either.`;
}

type SavedOrderKind = "limit" | "split buy" | "sell-off sale";

interface SavedOrder {
  readonly kind: SavedOrderKind;
  readonly orderId?: string;
  readonly clientOrderId?: string;
  readonly tracked?: TrackedOrder;
}

interface TradedOrder {
  readonly target: TrackedOrder;
  readonly order: OrderDetails;
}

interface SavedOrdersClosed {
  readonly traded: TradedOrder[];
  readonly cancelled: number;
  readonly replaced: number;
  readonly stillOpen: string[];
  readonly mayHoldCoins: boolean;
  readonly unlisted: string[];
  readonly unlistedMarket: string[];
}

const NOTHING_CLOSED: SavedOrdersClosed = {
  traded: [],
  cancelled: 0,
  replaced: 0,
  stillOpen: [],
  mayHoldCoins: false,
  unlisted: [],
  unlistedMarket: [],
};

export type GridStop = "end" | "pause";

function savedOrders(tracked: TrackedOrder[], state: GridState): SavedOrder[] {
  const orders: SavedOrder[] = tracked.map((target) => ({
    kind: "limit",
    orderId: target.orderId,
    tracked: target,
  }));
  for (const level of state.levels) {
    for (const clientOrderId of level.pendingBuyClientOrderIds ?? []) {
      orders.push({ kind: "limit", clientOrderId });
    }
    for (const position of level.positions) {
      if (position.sellClientOrderId && !position.sellOrderId) {
        orders.push({
          kind: "limit",
          clientOrderId: position.sellClientOrderId,
        });
      }
    }
  }
  if (state.splitOrderId || state.splitClientOrderId) {
    orders.push({
      kind: "split buy",
      orderId: state.splitOrderId,
      clientOrderId: state.splitClientOrderId,
    });
  }
  if (state.halt?.orderId || state.halt?.clientOrderId) {
    orders.push({
      kind: "sell-off sale",
      orderId: state.halt.orderId,
      clientOrderId: state.halt.clientOrderId,
    });
  }
  return orders;
}

function savedOrderLabel(order: SavedOrder): string {
  const id = order.orderId ?? `client order ID ${order.clientOrderId}`;
  return order.kind === "limit" ? id : `${order.kind} ${id}`;
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function closeProblems(result: GridOrdersClosed): string[] {
  return [...result.problems, ...result.unlisted.map(unlistedCancelProblem)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
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

function savedPrice(text: string | undefined): Decimal | null {
  if (!text) return null;
  try {
    const price = new Decimal(text);
    return price.isFinite() && price.gt(0) ? price : null;
  } catch {
    return null;
  }
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
  private _alertedSide: "below" | "above" | null = null;
  private _shouldRebuildUp = false;
  private readonly _telegramProblems = new Map<string, string>();
  private _keyLabel: string | null = null;
  private _keyRefusal: Error | null = null;
  private _cs: string;
  private _priceSource: LivePriceSource | null = null;
  private _onTick: ((event: GridBotTickEvent) => void) | null = null;
  private _tradeLogStart = 0;
  private _suppressDashboard = false;
  private _statusReporter: LiveStatusReporter | null = null;
  private _lifecycle: "running" | "finished" | "stopped" = "running";
  private _haltReason: GridHaltReason | null = null;
  private _liquidation: Promise<void> | null = null;
  private _shutdown: Promise<void> | null = null;
  private readonly _stopRequest = new AbortController();
  private _startup: Promise<void> | null = null;
  private _tickInFlight: Promise<void> | null = null;
  private _sellOffMessage: string | null = null;
  private _sellOffError: string | null = null;
  private _pendingSweepAt = 0;
  private readonly _pendingMissedOnce = new Set<string>();
  private readonly _placementHealth = new PlacementHealth();
  private readonly _unansweredSince = new Map<string, number>();
  private readonly _outage = new OutageWatch();
  private _changedOutside: {
    cancelled: number;
    replaced: number;
    lastAt: number;
  } | null = null;
  private _untrackedReplacements = 0;
  private readonly _selfCancelled = new Set<string>();
  private readonly _unidentified = new Set<string>();
  private readonly _historyRetryAt = new Map<string, number>();
  private _tickHistory: Promise<Order[]> | null = null;
  private _openBuyFills = new Decimal(0);
  private _ordersUnreachable = false;
  private _cashShortfall: {
    buys: number;
    free: Decimal;
    needed: Decimal;
  } | null = null;
  private readonly _rateLimiter: GridExchangeRateLimiter;
  private readonly _persistState: boolean;
  private readonly _orderConstraints: GridOrderConstraints | null;
  private readonly _humanOutput: NodeJS.WritableStream;
  private readonly _trailingUpPriceTracker: StablePriceTracker;

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
    this._trailingUpPriceTracker = new StablePriceTracker(
      options.trailingUpConfirmationTicks ?? TRAILING_UP_CONFIRMATION_TICKS,
    );
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

  private _orderGateway(): OrderGateway {
    return {
      cancel: (orderId) =>
        this._rateLimiter.cancel(() => this._client!.cancelOrder(orderId)),
      getOrder: async (orderId) =>
        (await this._rateLimiter.query(() => this._client!.getOrder(orderId)))
          .data,
      isActive: (orderId) => this._isOrderActive(orderId),
      sleep,
      now: () => Date.now(),
    };
  }

  private _cancelUntilClosed(orderId: string): Promise<CancelOutcome> {
    this._selfCancelled.add(orderId);
    return cancelUntilClosed(this._orderGateway(), orderId);
  }

  private _awaitTerminal(
    orderId: string,
    timeoutMs?: number,
  ): Promise<OrderDetails> {
    return awaitTerminal(this._orderGateway(), orderId, timeoutMs);
  }

  private async _closeGridOrders(
    state: GridState,
    policy: "settle" | "keepTraded",
  ): Promise<GridOrdersClosed> {
    const targets = this._trackedOrders(state);
    if (state.config.dryRun) {
      for (const target of targets) this._forgetOrder(target);
      return { cancelled: targets.length, problems: [], unlisted: [] };
    }
    const outcomes = await Promise.all(
      targets.map((target) => this._cancelUntilClosed(target.orderId)),
    );
    let cancelled = 0;
    const problems: string[] = [];
    const unlisted: string[] = [];
    for (const [index, target] of targets.entries()) {
      if (!this._isStillTracked(target)) continue;
      const outcome = outcomes[index];
      if (!outcome.closed) {
        problems.push(
          `Order ${target.orderId} did not reach a cancelled state.`,
        );
        continue;
      }
      const order = outcome.order;
      if (!order && this._recordMissing(target.orderId, state) === "waiting") {
        unlisted.push(target.orderId);
        continue;
      }
      if (order && this._hasFilledQuantity(order)) {
        if (policy === "keepTraded") {
          problems.push(
            `Order ${target.orderId} executed ${order.filled_quantity} before cancellation and must be reconciled.`,
          );
          continue;
        }
        await this._settleClosedOrder(state, target, order);
      } else {
        this._forgetOrder(target);
      }
      if (order && outsideChange(order) === "replaced") {
        this._untrackedReplacements++;
      } else if (
        order?.status === "cancelled" ||
        order?.status === "partially_filled"
      ) {
        cancelled++;
      }
    }
    return { cancelled, problems, unlisted };
  }

  private _trackedOrders(state: GridState): TrackedOrder[] {
    const targets: TrackedOrder[] = [];
    for (const level of state.levels) {
      for (const orderId of level.buyOrderIds) {
        targets.push({ level, orderId });
      }
      for (const position of level.positions) {
        if (position.sellOrderId) {
          targets.push({ level, orderId: position.sellOrderId, position });
        }
      }
    }
    return targets;
  }

  private _isStillTracked(target: TrackedOrder): boolean {
    if (!target.position) {
      return target.level.buyOrderIds.includes(target.orderId);
    }
    return (
      target.level.positions.includes(target.position) &&
      target.position.sellOrderId === target.orderId
    );
  }

  private _forgetOrder(target: TrackedOrder): void {
    if (!target.position) {
      this._dropBuyOrder(target.level, target.orderId);
      return;
    }
    this._clearSellOrder(target.position);
  }

  private _clearSellOrder(position: GridLevelPosition): void {
    position.sellOrderId = null;
    position.sellBaseSize = undefined;
    position.sellClientOrderId = undefined;
  }

  private async _settleClosedOrder(
    state: GridState,
    target: TrackedOrder,
    order: OrderDetails,
  ): Promise<void> {
    if (!target.position) {
      await this._processTerminalBuy(target.level, order, false, false);
      return;
    }
    const sellLevel = state.levels[target.level.index + 1] ?? target.level;
    await this._processTerminalSell(
      target.level,
      sellLevel,
      target.position,
      order,
      false,
      false,
    );
  }

  private async _discardSavedGrid(saved: GridState): Promise<void> {
    if (!saved.config.dryRun) {
      this._log(
        chalk.dim(
          this._config.reset
            ? "  --reset flag: cancelling saved grid orders..."
            : "  Previous grid was stopped. Cancelling its leftover orders...",
        ),
      );
    }
    saved.stopped = true;
    this._saveGridState(saved);
    const closed = saved.config.dryRun
      ? NOTHING_CLOSED
      : await this._closeSavedGridOrders(saved);
    const { stillOpen } = closed;
    if (stillOpen.length > 0) {
      throw new Error(
        `The cancel of ${countOf(stillOpen.length, "order")} of the old grid isn't confirmed: ${stillOpen.join(", ")}. The next start cancels ${stillOpen.length === 1 ? "it" : "them"} again before it begins a new grid. If a grid order stays open, cancel it with revx order cancel <id> first.`,
      );
    }
    this._deleteGridState(this._config.pair);
    const notes = this._leftoverNotes(saved, closed);
    for (const note of notes) this._log(chalk.yellow(`  ${note}`));
    if (notes.length > 0) {
      void this._notify(
        [
          `Grid Bot ${this._config.reset ? "reset" : "previous run cleaned up"}: ${this._config.pair}`,
          ...notes,
        ].join("\n"),
      );
    }
  }

  private async _endGrid(state: GridState): Promise<string[]> {
    state.stopped = true;
    this._saveGridState(state);
    const notes: string[] = [];
    let closed = state.config.dryRun
      ? { ...NOTHING_CLOSED, cancelled: this._trackedOrders(state).length }
      : NOTHING_CLOSED;
    try {
      if (!state.config.dryRun) {
        closed = await this._closeSavedGridOrders(state);
        for (const { target, order } of closed.traded) {
          if (this._isStillTracked(target)) {
            await this._settleClosedOrder(state, target, order);
          }
        }
      }
    } catch (err) {
      if (err instanceof InsecureKeyPermissionsError) {
        notes.push(
          "\u26A0 Credential file permissions are unsafe, so open exchange orders may not be cancelled. Fix the key permissions, then cancel them with revx order cancel --all.",
          err.message,
        );
      } else {
        notes.push(
          `\u26A0 The grid's orders couldn't all be checked: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    }
    this._untrackedReplacements += closed.replaced;
    if (closed.cancelled > 0) {
      this._log(chalk.dim(`  Cancelled ${countOf(closed.cancelled, "order")}`));
    }
    const { stillOpen } = closed;
    const unlisted = [...closed.unlisted, ...closed.unlistedMarket];
    if (stillOpen.length > 0) {
      notes.push(
        `\u26A0 The cancel of ${countOf(stillOpen.length, "order")} isn't confirmed: ${stillOpen.join(", ")}.`,
      );
    }
    if (unlisted.length > 0) {
      notes.push(
        `\u26A0 The exchange doesn't list ${countOf(unlisted.length, "order")} of the grid yet: ${unlisted.join(", ")}.`,
      );
    }
    if (notes.length > 0) {
      notes.push(
        "The save is kept, so the next start checks these orders first, then begins a new grid.",
      );
    } else {
      this._deleteGridState(state.pair);
    }
    if (this._untrackedReplacements > 0) {
      notes.push(
        `\u26A0 ${untrackedReplacementsNote(this._untrackedReplacements)}`,
      );
    }
    if (
      !state.config.dryRun &&
      (closed.mayHoldCoins || this._hasTrackedInventory(state))
    ) {
      const base = this._config.pair.split("-")[0] ?? "";
      notes.push(
        `Any ${base} the grid bought and didn't sell stays in the wallet. The next start begins a new grid.`,
      );
    }
    return notes;
  }

  private async _pauseGrid(state: GridState): Promise<string[]> {
    let cancelled = 0;
    let remaining =
      (state.splitClientOrderId || state.splitOrderId ? 1 : 0) +
      state.levels.reduce(
        (count, level) =>
          count +
          (level.pendingBuyClientOrderIds?.length ?? 0) +
          level.positions.filter(
            (position) => !!position.sellClientOrderId && !position.sellOrderId,
          ).length,
        0,
      );
    try {
      const result = await this._closeGridOrders(state, "keepTraded");
      cancelled = result.cancelled;
      remaining += closeProblems(result).length;
    } catch {
      remaining += state.levels.reduce(
        (count, level) =>
          count +
          level.buyOrderIds.length +
          level.positions.filter((position) => !!position.sellOrderId).length,
        0,
      );
    }
    const hasTrackedInventory =
      !state.config.dryRun && this._hasTrackedInventory(state);
    if (remaining === 0 && !hasTrackedInventory) {
      this._deleteGridState(state.pair);
    } else {
      this._saveGridState(state);
    }
    if (cancelled > 0) {
      this._log(chalk.dim(`  Cancelled ${countOf(cancelled, "order")}`));
    }
    const notes: string[] = [];
    if (remaining > 0) {
      notes.push(
        `\u26A0 ${countOf(remaining, "order")} could not be cancelled. State saved for next startup.`,
      );
    } else if (hasTrackedInventory) {
      const base = this._config.pair.split("-")[0] ?? "";
      notes.push(
        `\u26A0 Acquired ${base} remains. State saved for the next startup.`,
      );
    }
    if (this._untrackedReplacements > 0) {
      notes.push(
        `\u26A0 ${untrackedReplacementsNote(this._untrackedReplacements)}`,
      );
    }
    return notes;
  }

  private async _closeSavedGridOrders(
    saved: GridState,
  ): Promise<SavedOrdersClosed> {
    const orders = await this._withOrderIds(
      saved,
      savedOrders(this._trackedOrders(saved), saved),
    );
    const byOrderId = new Map<string, SavedOrder>();
    for (const order of orders) {
      if (order.orderId) byOrderId.set(order.orderId, order);
    }
    const targets = [...byOrderId];
    const outcomes = await Promise.all(
      targets.map(([orderId]) => this._cancelUntilClosed(orderId)),
    );
    const unlisted = orders.filter((order) => !order.orderId);
    const traded: TradedOrder[] = [];
    const stillOpen: string[] = [];
    let cancelled = 0;
    let replaced = 0;
    let bought = false;
    for (const [index, outcome] of outcomes.entries()) {
      const [, target] = targets[index];
      if (!outcome.closed) {
        stillOpen.push(savedOrderLabel(target));
        continue;
      }
      if (!outcome.order) {
        unlisted.push(target);
        continue;
      }
      if (target.tracked && this._hasFilledQuantity(outcome.order)) {
        traded.push({ target: target.tracked, order: outcome.order });
      }
      if (outsideChange(outcome.order) === "replaced") {
        replaced++;
      } else {
        if (CANCELLED_STATUSES.has(outcome.order.status)) cancelled++;
        if (outcome.order.side === "buy") {
          bought ||= this._hasFilledQuantity(outcome.order);
        }
      }
    }
    return {
      traded,
      cancelled,
      replaced,
      stillOpen,
      mayHoldCoins:
        bought || unlisted.some((order) => order.kind === "split buy"),
      unlisted: unlisted
        .filter((order) => order.kind === "limit")
        .map(savedOrderLabel),
      unlistedMarket: unlisted
        .filter((order) => order.kind !== "limit")
        .map(savedOrderLabel),
    };
  }

  private async _withOrderIds(
    saved: GridState,
    orders: SavedOrder[],
  ): Promise<SavedOrder[]> {
    if (orders.every((order) => order.orderId)) return orders;
    const sent = await this._ordersByClientOrderId(
      this._gridHistoryStart(saved),
    );
    return orders.map((order) =>
      order.orderId || !order.clientOrderId
        ? order
        : { ...order, orderId: sent.get(order.clientOrderId)?.id },
    );
  }

  private _leftoverNotes(
    saved: GridState,
    closed: SavedOrdersClosed,
  ): string[] {
    const notes: string[] = [];
    const { unlisted, unlistedMarket } = closed;
    if (unlisted.length > 0) {
      notes.push(
        `\u26A0 The exchange doesn't list ${countOf(unlisted.length, "order")} of the old grid: ${unlisted.join(", ")}. If revx order open --json shows ${unlisted.length === 1 ? "it" : "one"} in the next few minutes, cancel it with revx order cancel <id>.`,
      );
    }
    if (unlistedMarket.length > 0) {
      notes.push(
        `\u26A0 The exchange doesn't list ${countOf(unlistedMarket.length, "market order")} of the old grid: ${unlistedMarket.join(", ")}. ${unlistedMarket.length === 1 ? "It" : "They"} may still trade in the next few minutes. Check with revx order history.`,
      );
    }
    if (closed.replaced > 0) {
      notes.push(`\u26A0 ${untrackedReplacementsNote(closed.replaced)}`);
    }
    if (saved.halt) notes.push("The old grid's pending sell-off is dropped.");
    if (
      !saved.config.dryRun &&
      (closed.mayHoldCoins || this._hasTrackedInventory(saved))
    ) {
      const base = this._config.pair.split("-")[0] ?? "";
      notes.push(
        `Any ${base} the old grid bought and didn't sell stays in the wallet. The new grid doesn't manage it.`,
      );
    }
    return notes;
  }

  async run(): Promise<void> {
    try {
      await this._run();
      this._printSellOff();
    } catch (err) {
      if (err instanceof OrderNotSentError) return;
      if (err instanceof OrderRejectedError) {
        this.stop();
        this._log(
          chalk.red(
            `\n  Halting grid bot: ${err.side} order at ${err.price} ${err.reason}. Selling all held coins.`,
          ),
        );
        try {
          if (this._state && this._client) {
            await this._liquidate("rejected-orders");
          }
        } finally {
          await this.shutdown();
        }
      }
      this._printSellOff();
      throw err;
    }
  }

  private async _run(): Promise<void> {
    this._startup = this._startUp();
    await this._startup;
    if (!this._running || this._isStopping()) return;
    void this._notify(
      renderStartedMessage(this._state!.pair, this._state!.config),
    );
    if (this._connections.length > 0) {
      this._statusReporter = new LiveStatusReporter({
        connections: this._connections,
        refs: this._state!.statusMessages,
        minIntervalMs: Math.max(5000, this._config.intervalSec * 1000),
        parseMode: "MarkdownV2",
        onResult: (connectionId, result) =>
          this._noteTelegram(connectionId, result),
      });
      await this._statusReporter.flush(this._renderStatusCard());
      this._state!.statusMessages = this._statusReporter.snapshot();
      this._saveGridState(this._state!);
    }
    await this._loop();
  }

  private async _startUp(): Promise<void> {
    this._running = true;
    this._startTime = Date.now();
    this._client = new RevolutXClient({
      generatedBy: "CLI",
      enforceKeyPermissions: true,
    });
    this._keyLabel = savedKeyLabel();
    this._connections = loadConnections().filter((c) => c.enabled);

    this._client.assertAuthenticated();

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
    await this._startFromSave();
  }

  private async _startFromSave(): Promise<void> {
    const existingState = this._loadSavedGrid();

    if (existingState && (this._config.reset || existingState.stopped)) {
      await this._discardSavedGrid(existingState);
      await this._initNewGrid();
    } else if (existingState) {
      if (existingState.halt) {
        this._assertHaltedModeMatches(existingState);
      } else {
        this._assertSavedConfigMatches(existingState);
      }
      await this._reconcileAndInit(existingState);
    } else {
      await this._initNewGrid();
    }
  }

  private _printSellOff(): void {
    if (this._sellOffMessage && this._persistState) {
      this._log(chalk.red(`\n  ${this._sellOffMessage}`));
    }
    this._sellOffMessage = null;
  }

  private _assertSavedConfigMatches(existingState: GridState): void {
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
      !new Decimal(existingState.config.investment).eq(this._config.investment)
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

    if (Boolean(existingState.config.trailingUp) !== this._config.trailingUp) {
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
  }

  private _loadSavedGrid(): GridState | null {
    try {
      return loadGridState(this._config.pair);
    } catch (err) {
      if (!(err instanceof GridStateDamagedError)) throw err;
      if (!this._config.reset) {
        throw new Error(
          `${err.message}. Nothing was started, so the old grid's orders and coins are untouched. ` +
            `A new grid can't take them over, so first cancel the old grid's open orders in the Revolut X app and decide what to do with its coins. ` +
            `Then run again with --reset to set the damaged file aside and start a new grid.`,
        );
      }
      if (this._persistState) {
        const keptAt = setAsideGridState(this._config.pair);
        this._log(
          chalk.yellow(
            `  Damaged saved grid set aside as ${keptAt}. Its old orders are not tracked by the new grid.`,
          ),
        );
      }
      return null;
    }
  }

  private _assertHaltedModeMatches(existingState: GridState): void {
    if (existingState.config.dryRun === this._config.dryRun) return;
    const savedMode = existingState.config.dryRun ? "dry-run" : "live";
    throw new Error(
      `A sell-off of the saved ${savedMode} grid is still pending. Run it in ${savedMode} mode to finish it.`,
    );
  }

  async shutdown(stop: GridStop = "end"): Promise<void> {
    this._stopRequest.abort();
    this._shutdown ??= this._shutdownOnce(stop);
    return this._shutdown;
  }

  private _isStopping(): boolean {
    return this._stopRequest.signal.aborted;
  }

  private _refuseWhenStopping(): Error | null {
    return this._isStopping() ? new OrderNotSentError() : null;
  }

  private async _shutdownOnce(stop: GridStop): Promise<void> {
    if (this._startup) await this._startup.catch(() => undefined);
    if (!this._state || !this._client) return;
    if (this._tickInFlight) await this._tickInFlight.catch(() => undefined);
    if (this._liquidation) await this._liquidation.catch(() => undefined);
    if (this._lifecycle === "stopped") {
      this._printSellOff();
      return;
    }

    this._log(chalk.dim("\n  Cancelling open orders..."));
    const notes =
      stop === "end"
        ? await this._endGrid(this._state)
        : await this._pauseGrid(this._state);

    let currentPrice: Decimal;
    try {
      currentPrice = await this._getCurrentPrice();
    } catch {
      currentPrice = new Decimal(this._state.gridPrice);
    }

    this._log(renderShutdownSummary(this._state, currentPrice, notes));

    const s = this._state.stats;
    this._currentPrice = currentPrice;
    const { realizedPnl, unrealized, totalPnl, netValue } =
      this._computePnl(currentPrice);

    const cs = this._cs;

    await this._notify(
      `Grid Bot stopped: ${this._state.pair}\n` +
        `${s.totalBuys} buys, ${s.totalSells} sells\n` +
        `Realized P&L: ${fmtSignedPnl(realizedPnl, cs)}\n` +
        `Unrealized: ${fmtSignedPnl(unrealized, cs)}\n` +
        `Total P&L: ${fmtSignedPnl(totalPnl, cs)}\n` +
        `Net Value: ${fmtMoney(netValue, cs)}` +
        (this._untrackedReplacements > 0
          ? `\n${untrackedReplacementsNote(this._untrackedReplacements)}`
          : ""),
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

  private async _getActiveOrders(): Promise<Map<string, Order>> {
    const activeOrders = new Map<string, Order>();
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
        activeOrders.set(order.id, order);
      }
      cursor = response.metadata?.next_cursor as string | undefined;
    } while (cursor);
    return activeOrders;
  }

  private async _isOrderActive(orderId: string): Promise<boolean> {
    return (await this._getActiveOrders()).has(orderId);
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
      if (
        trailUpPrice !== null &&
        this._trailingUpPriceTracker.observe(currentPrice, (price) =>
          price.gte(trailUpPrice),
        )
      ) {
        this._shouldRebuildUp = true;
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
      if (this._alertedSide !== direction) {
        this._alertedSide = direction;
        const risk = below
          ? "All grid levels are above the price, so the grid holds coins and waits for the price to come back to its sells."
          : "All grid levels are below the price, so the grid waits for the price to come back to its buys.";
        void this._notify(
          `Grid Bot ${state.pair}: Price exited grid range (${direction} ${fmtPrice(boundary, cs)}). ` +
            `Current: ${fmtPrice(currentPrice, cs)}. ${risk}`,
        );
      }
    } else if (this._backInGrid(currentPrice, levels)) {
      this._alertedSide = null;
    }
  }

  private _backInGrid(price: Decimal, levels: GridLevelState[]): boolean {
    if (this._alertedSide === "below") return price.gte(levels[1].price);
    if (this._alertedSide === "above") {
      return price.lte(levels[levels.length - 2].price);
    }
    return false;
  }

  private _buyQuoteOnLevel(level: GridLevelState): Decimal {
    const quotePerLevel = new Decimal(this._state!.quotePerLevel);
    const placed = level.buyOrderIds.map(
      (orderId) => level.buyOrderQuoteSizes?.[orderId] ?? quotePerLevel,
    );
    const pending = (level.pendingBuyClientOrderIds ?? []).map(
      (clientOrderId) =>
        level.pendingBuyQuoteSizes?.[clientOrderId] ?? quotePerLevel,
    );
    return [...placed, ...pending].reduce<Decimal>(
      (sum, quote) => sum.plus(quote),
      new Decimal(0),
    );
  }

  private _fullBuyCount(level: GridLevelState): number {
    return this._buyQuoteOnLevel(level)
      .div(this._state!.quotePerLevel)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();
  }

  private _missingBuyQuotes(level: GridLevelState): Decimal[] {
    const quotePerLevel = new Decimal(this._state!.quotePerLevel);
    let missing = quotePerLevel
      .times(level.expectedBuys ?? 1)
      .minus(this._buyQuoteOnLevel(level));
    const quotes: Decimal[] = [];
    while (missing.gte(quotePerLevel)) {
      quotes.push(quotePerLevel);
      missing = missing.minus(quotePerLevel);
    }
    const remainder = floorToStep(missing, this._getQuoteStep());
    if (remainder.gt(0) && this._isPlaceableBuy(level, remainder)) {
      quotes.push(remainder);
    }
    return quotes;
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

    const savedCounts = state.levels.map((level) => this._fullBuyCount(level));

    const quoteStep = this._getQuoteStep();
    const rebuildPlan = createTrailingGridRebuildPlan({
      levels: state.levels.map((level) => ({
        index: level.index,
        price: new Decimal(level.price),
      })),
      currentPrice,
      split: this._config.splitInvestment,
      buyCounts: savedCounts,
      quoteStep,
    });
    const candidatePrices = rebuildPlan.levels.map((level) => level.price);
    const constraints = this._getOrderConstraints();
    const quotePerLevel = new Decimal(state.quotePerLevel);

    for (let i = 0; i < candidatePrices.length; i++) {
      const price = candidatePrices[i];
      if (!price.gt(0) || (i > 0 && !price.gt(candidatePrices[i - 1]))) {
        throw new Error(
          "Trailing grid does not produce unique prices at the pair precision.",
        );
      }
      const count = rebuildPlan.buyCounts[i];
      if (count > 0) {
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
      const problems = closeProblems(
        await this._closeGridOrders(state, "keepTraded"),
      );
      if (problems.length > 0) {
        this._saveGridState(state);
        throw new Error(
          `Unable to rebuild grid because ${problems.length} order cancellation${problems.length === 1 ? "" : "s"} failed: ${problems[0]}`,
        );
      }
    }

    for (const level of state.levels) {
      level.buyOrderIds = [];
      level.buyOrderQuoteSizes = {};
      level.buyClientOrderIds = {};
      level.positions = [];
    }
    this._placementHealth.reset();
    this._cashShortfall = null;

    for (let i = 0; i < N; i++) {
      state.levels[i].price = candidatePrices[i].toString();
    }

    state.gridPrice = currentPrice.toString();

    const rebuilds: Array<{
      level: GridLevelState;
      placement: Promise<unknown>;
    }> = [];
    for (let i = 0; i < N; i++) {
      const level = state.levels[i];
      const count = rebuildPlan.buyCounts[i];
      level.expectedBuys = count;
      if (count === 0) continue;

      for (let j = 0; j < count; j++) {
        rebuilds.push({
          level,
          placement: this._placeBuyOrder(level, quotePerLevel),
        });
      }
    }
    const rebuildResults = await Promise.allSettled(
      rebuilds.map((rebuild) => rebuild.placement),
    );
    rebuildResults.forEach((result, index) => {
      if (result.status !== "rejected") return;
      rethrowIfInsecureKey(result.reason);
      this._alertBuyFailure(
        rebuilds[index].level,
        quotePerLevel,
        result.reason,
      );
    });

    state.shiftCount = (state.shiftCount ?? 0) + 1;
    this._saveGridState(state);
    this._trailingUpPriceTracker.reset();
    this._alertedSide = null;
    if (this._isStopping()) return;

    void this._notify(
      `Grid Bot ${state.pair}: trailing up — grid rebuilt around ${fmtPrice(currentPrice, cs)} ` +
        `(shift #${state.shiftCount})`,
    );
  }

  private _liquidate(
    reason: GridHaltReason,
    referencePrice?: Decimal,
  ): Promise<void> {
    this._liquidation ??= this._sellEverything(reason, referencePrice);
    return this._liquidation;
  }

  private async _sellEverything(
    reason: GridHaltReason,
    referencePrice?: Decimal,
  ): Promise<void> {
    const state = this._state!;
    const resumed = state.halt !== undefined;
    state.halt ??= {
      reason,
      triggerPrice: (referencePrice ?? this._currentPrice)?.toFixed(),
    };
    this._haltReason = state.halt.reason;
    this._lifecycle = "stopped";
    this._saveGridState(state);
    const marketPrice =
      referencePrice ??
      (await this._getCurrentPrice().catch((err) => {
        rethrowIfInsecureKey(err);
        return null;
      })) ??
      this._currentPrice;
    const price = marketPrice ?? new Decimal(state.gridPrice);
    if (!resumed && marketPrice) {
      state.halt.triggerPrice ??= marketPrice.toFixed();
    }
    const triggerPrice = savedPrice(state.halt.triggerPrice);
    const summary: SellOffSummary = {
      soldBase: new Decimal(0),
      soldQuote: new Decimal(0),
      unpricedFill: false,
      writtenOff: new Decimal(0),
      cancelled: 0,
    };
    let complete = false;
    let latestPrice: Decimal | null = null;
    try {
      ({ complete, latestPrice } = await this._closeOutUntilDone(
        state,
        price,
        summary,
      ));
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._recordSellOffError(
        `Sell-off: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (complete) state.halt = undefined;
    this._saveGridState(state);
    this.stop();
    if (complete) this._deleteGridState(state.pair);
    this._currentPrice = latestPrice ?? price;
    await this._reportSellOff(
      state,
      {
        marketPrice,
        priceNow: latestPrice ?? marketPrice,
        triggerPrice,
        resumed,
      },
      summary,
      complete,
    );
  }

  private async _closeOutUntilDone(
    state: GridState,
    price: Decimal,
    summary: SellOffSummary,
  ): Promise<{ complete: boolean; latestPrice: Decimal | null }> {
    let latestPrice: Decimal | null = null;
    let result = await this._closeOutGrid(state, price, summary);
    if (result.outcome === "waiting") {
      this._announceSellOffWait(state);
      const waitUntil = performance.now() + SELL_OFF_WAIT_LIMIT_MS;
      while (
        result.outcome === "waiting" &&
        !this._isStopping() &&
        performance.now() < waitUntil
      ) {
        await pause(SELL_OFF_RETRY_MS, this._stopRequest.signal);
        if (this._isStopping()) break;
        latestPrice = (await this._priceOrNull()) ?? latestPrice;
        result = await this._closeOutGrid(state, latestPrice ?? price, summary);
      }
    }
    if (result.outcome === "waiting") this._recordSellOffError(result.reason);
    return { complete: result.outcome === "complete", latestPrice };
  }

  private async _priceOrNull(): Promise<Decimal | null> {
    try {
      return await this._getCurrentPrice();
    } catch (err) {
      rethrowIfInsecureKey(err);
      return null;
    }
  }

  private _announceSellOffWait(state: GridState): void {
    const message =
      `The sell-off waits for orders the exchange doesn't confirm yet. ` +
      `It checks again every ${SELL_OFF_RETRY_MS / 1000} seconds for up to ${SELL_OFF_WAIT_LIMIT_MS / 60_000} minutes. ` +
      `Ctrl+C stops the wait and keeps the sale for the next start.`;
    this._log(chalk.yellow(`  ${message}`));
    void this._notify(`Grid Bot ${state.pair}: ${message}`);
  }

  private async _closeOutGrid(
    state: GridState,
    price: Decimal,
    summary: SellOffSummary,
  ): Promise<CloseOut> {
    let lookupError: string | null = null;
    let splitSettled = true;
    if (!state.config.dryRun) {
      try {
        await this._finishPendingSale(state, price, summary);
        await this._resumePendingPlacements(false);
        splitSettled = await this._settleSplitInFlight();
      } catch (err) {
        rethrowIfInsecureKey(err);
        lookupError = `Sell-off: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!lookupError && splitSettled) this._materialiseSplitBase(state);
    const { cancelled, problems, unlisted } = await this._closeGridOrders(
      state,
      "settle",
    );
    summary.cancelled += cancelled;
    if (lookupError) return { outcome: "waiting", reason: lookupError };
    const sale = await this._sellHeldCoins(state, price, summary);
    if (sale.outcome !== "complete") return sale;
    const blocking = [...problems, ...unlisted.map(unlistedCancelProblem)];
    if (blocking.length > 0) {
      return { outcome: "waiting", reason: describeProblems(blocking) };
    }
    const unconfirmed = this._unconfirmedPlacements(state);
    if (unconfirmed > 0) {
      return {
        outcome: "waiting",
        reason:
          `${unconfirmed} order${unconfirmed === 1 ? "" : "s"} sent before the sell-off ${unconfirmed === 1 ? "isn't" : "aren't"} confirmed yet. ` +
          `The next start looks again and gives up on any still missing after 5 minutes.`,
      };
    }
    if (this._hasPendingPlacements(state)) {
      this._recordSellOffError(
        "Some grid orders are not confirmed closed yet.",
      );
      return { outcome: "failed" };
    }
    this._writeOffUnsellable(state, summary);
    return { outcome: "complete" };
  }

  private _unconfirmedPlacements(state: GridState): number {
    let count = state.splitClientOrderId && !state.splitOrderId ? 1 : 0;
    for (const level of state.levels) {
      count += level.pendingBuyClientOrderIds?.length ?? 0;
      count += level.positions.filter(
        (position) => !!position.sellClientOrderId && !position.sellOrderId,
      ).length;
    }
    return count;
  }

  private _isFreeToSell(position: GridLevelPosition): boolean {
    return !position.sellOrderId && !position.sellClientOrderId;
  }

  private _noteMissing(
    orderId: string,
    state = this._state!,
    listedAt = Date.now(),
  ): number {
    const misses = (state.missingSince ??= {});
    const firstMiss = Date.parse(misses[orderId] ?? "");
    if (Number.isFinite(firstMiss)) return listedAt - firstMiss;
    misses[orderId] = new Date().toISOString();
    this._saveGridState(state);
    return 0;
  }

  private _recordMissing(
    orderId: string,
    state = this._state!,
    listedAt = Date.now(),
  ): "waiting" | "gone" {
    if (this._noteMissing(orderId, state, listedAt) < UNCONFIRMED_GRACE_MS) {
      return "waiting";
    }
    this._forgetMissing(orderId, state);
    return "gone";
  }

  private _noLongerMissing(orderId: string): void {
    this._forgetMissing(orderId, this._state!);
  }

  private _forgetMissing(orderId: string, state: GridState): void {
    delete state.missingSince?.[orderId];
    this._unidentified.delete(orderId);
    this._historyRetryAt.delete(orderId);
  }

  private _pruneMissing(state: GridState): void {
    const tracked = new Set<string>();
    for (const level of state.levels) {
      level.buyOrderIds.forEach((id) => tracked.add(id));
      (level.pendingBuyClientOrderIds ?? []).forEach((id) => tracked.add(id));
      for (const position of level.positions) {
        if (position.sellOrderId) tracked.add(position.sellOrderId);
        if (position.sellClientOrderId) tracked.add(position.sellClientOrderId);
      }
    }
    if (state.splitOrderId) tracked.add(state.splitOrderId);
    if (state.splitClientOrderId) tracked.add(state.splitClientOrderId);
    if (state.usedClientOrderIds) {
      state.usedClientOrderIds = state.usedClientOrderIds.filter((id) =>
        tracked.has(id),
      );
    }
    for (const id of Object.keys(state.missingSince ?? {})) {
      if (!tracked.has(id)) this._forgetMissing(id, state);
    }
  }

  private async _finishPendingSale(
    state: GridState,
    price: Decimal,
    summary: SellOffSummary,
  ): Promise<void> {
    const halt = state.halt!;
    let orderId = halt.orderId;
    if (!orderId && halt.clientOrderId) {
      orderId = (await this._ordersByClientOrderId()).get(
        halt.clientOrderId,
      )?.id;
    }
    if (!orderId) return;
    const order = await this._awaitTerminal(orderId);
    const sellable = new Set(
      state.levels
        .flatMap((level) => level.positions)
        .filter((position) => this._isFreeToSell(position)),
    );
    this._bookSale(state, order, price, summary, sellable);
  }

  private async _sellHeldCoins(
    state: GridState,
    price: Decimal,
    summary: SellOffSummary,
  ): Promise<CloseOut> {
    const constraints = this._getOrderConstraints();
    let emptyAttempts = 0;
    for (;;) {
      const sellable = new Set(
        state.levels
          .flatMap((level) => level.positions)
          .filter(
            (position) =>
              this._isFreeToSell(position) &&
              new Decimal(position.baseHeld).gt(0),
          ),
      );
      const held = [...sellable].reduce(
        (sum, position) => sum.plus(position.baseHeld),
        new Decimal(0),
      );
      let amount = Decimal.min(
        floorToStep(held, constraints.baseStep),
        constraints.maxBase,
      );
      if (!amount.gt(0)) return { outcome: "complete" };
      try {
        amount = normalizeBaseOrderSize(amount, constraints, price);
      } catch {
        return { outcome: "complete" };
      }
      if (this._isStopping()) {
        this._recordSellOffError(STOPPED_BEFORE_SALE);
        return { outcome: "failed" };
      }
      if (state.config.dryRun) {
        this._bookSimulatedSale(state, amount, price, sellable, summary);
        continue;
      }
      const sale = await this._placeSellOffOrder(
        state,
        amount,
        price,
        sellable,
        summary,
      );
      if (sale.outcome !== "sold") return sale;
      if (!sale.filled.gt(0)) {
        emptyAttempts++;
        if (emptyAttempts >= MAX_EMPTY_SALES) {
          this._recordSellOffError(
            `The last ${MAX_EMPTY_SALES} sales filled nothing.`,
          );
          return { outcome: "failed" };
        }
      }
    }
  }

  private async _placeSellOffOrder(
    state: GridState,
    amount: Decimal,
    price: Decimal,
    sellable: Set<GridLevelPosition>,
    summary: SellOffSummary,
  ): Promise<SaleOutcome> {
    const halt = state.halt!;
    const minted = halt.clientOrderId === undefined;
    halt.clientOrderId ??= randomUUID();
    halt.orderId = undefined;
    this._saveGridState(state);
    let orderId: string;
    try {
      const response = await this._rateLimiter.place(
        () =>
          this._client!.placeOrder({
            symbol: this._config.pair,
            side: "sell",
            clientOrderId: halt.clientOrderId,
            market: { baseSize: amount.toString() },
          }),
        () => this._refuseWhenStopping(),
      );
      orderId = response.data.venue_order_id;
    } catch (err) {
      rethrowIfInsecureKey(err);
      if (err instanceof OrderNotSentError) {
        if (minted) halt.clientOrderId = undefined;
        this._saveGridState(state);
        this._recordSellOffError(STOPPED_BEFORE_SALE);
        return { outcome: "failed" };
      }
      this._recordSellOffError(
        `Sell-off order: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { outcome: "failed" };
    }
    halt.orderId = orderId;
    this._saveGridState(state);
    let order: OrderDetails;
    try {
      order = await this._awaitTerminal(orderId);
    } catch (err) {
      rethrowIfInsecureKey(err);
      return {
        outcome: "waiting",
        reason: `Sell-off order: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      outcome: "sold",
      filled: this._bookSale(state, order, price, summary, sellable),
    };
  }

  private _bookSale(
    state: GridState,
    order: OrderDetails,
    price: Decimal,
    summary: SellOffSummary,
    sellable: Set<GridLevelPosition>,
  ): Decimal {
    const { baseDelivered, quoteProceeds, feeQuote } = this._sellEconomics(
      order,
      price,
    );
    const held = state.levels
      .flatMap((level) => level.positions)
      .filter((position) => sellable.has(position))
      .reduce((sum, position) => sum.plus(position.baseHeld), new Decimal(0));
    const filledBase = Decimal.min(baseDelivered, held);
    if (filledBase.gt(0)) {
      const share = filledBase.div(baseDelivered);
      const proceeds = quoteProceeds.times(share);
      const fee = feeQuote.times(share);
      const cost = this._consumeHeldBase(filledBase, sellable);
      const pnl = proceeds.minus(cost);
      this._addFee(fee);
      state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
        .plus(pnl)
        .toString();
      state.stats.totalSells++;
      this._logTrade(
        "sell",
        this._executionPrice(order, price).toString(),
        filledBase.toString(),
        this._sellOffTag(state),
        pnl.toFixed(2),
        fee.toString(),
      );
      summary.soldBase = summary.soldBase.plus(filledBase);
      summary.soldQuote = summary.soldQuote.plus(
        this._filledAmount(order, price).times(share),
      );
      if (!order.filled_amount && !order.average_fill_price) {
        summary.unpricedFill = true;
      }
    }
    state.halt!.orderId = undefined;
    state.halt!.clientOrderId = undefined;
    this._saveGridState(state);
    return filledBase;
  }

  private _bookSimulatedSale(
    state: GridState,
    amount: Decimal,
    price: Decimal,
    sellable: Set<GridLevelPosition>,
    summary: SellOffSummary,
  ): void {
    const cost = this._consumeHeldBase(amount, sellable);
    const gross = amount.times(price);
    const fee = gross.times(TAKER_FEE_RATE);
    const proceeds = gross.minus(fee).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const pnl = proceeds.minus(cost);
    this._addFee(fee);
    state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
      .plus(pnl)
      .toString();
    state.stats.totalSells++;
    this._logTrade(
      "sell",
      price.toString(),
      amount.toString(),
      this._sellOffTag(state),
      pnl.toFixed(2),
      fee.toString(),
    );
    summary.soldBase = summary.soldBase.plus(amount);
    summary.soldQuote = summary.soldQuote.plus(gross);
    this._saveGridState(state);
  }

  private _recordSellOffError(message: string): void {
    this._sellOffError = message;
    this._warnings.push(message);
  }

  private _sellOffTag(state: GridState): string {
    return state.halt?.reason === "rejected-orders" ? "close-all" : "stop-loss";
  }

  private _writeOffUnsellable(state: GridState, summary: SellOffSummary): void {
    for (const level of state.levels) {
      for (const position of [...level.positions]) {
        if (!this._isFreeToSell(position)) continue;
        const cost =
          position.fillCost && position.fillCost !== "0"
            ? new Decimal(position.fillCost)
            : new Decimal(state.quotePerLevel);
        state.stats.realizedPnl = new Decimal(state.stats.realizedPnl)
          .minus(cost)
          .toString();
        summary.writtenOff = summary.writtenOff.plus(position.baseHeld);
        level.positions = level.positions.filter(
          (candidate) => candidate !== position,
        );
      }
    }
    this._saveGridState(state);
  }

  private _hasPendingPlacements(state: GridState): boolean {
    return (
      !!state.splitClientOrderId ||
      !!state.splitOrderId ||
      state.levels.some(
        (level) =>
          level.buyOrderIds.length > 0 ||
          (level.pendingBuyClientOrderIds?.length ?? 0) > 0 ||
          level.positions.some(
            (position) =>
              !!position.sellOrderId || !!position.sellClientOrderId,
          ),
      )
    );
  }

  private async _settleSplitInFlight(): Promise<boolean> {
    const state = this._state!;
    if (!state.splitOrderId && state.splitClientOrderId) {
      const clientOrderId = state.splitClientOrderId;
      const found = (await this._ordersByClientOrderId()).get(clientOrderId);
      if (!found) {
        if (this._recordMissing(clientOrderId) === "waiting") return false;
        state.splitClientOrderId = undefined;
        state.splitOrderQuoteSize = undefined;
        this._saveGridState(state);
        return true;
      }
      this._noLongerMissing(clientOrderId);
      state.splitOrderId = found.id;
      this._saveGridState(state);
    }
    if (!state.splitOrderId) return true;
    const order = await this._awaitTerminal(state.splitOrderId);
    if (this._hasFilledQuantity(order)) {
      this._recordSplitFill(order);
      return true;
    }
    state.splitOrderId = undefined;
    state.splitClientOrderId = undefined;
    state.splitOrderQuoteSize = undefined;
    this._saveGridState(state);
    return true;
  }

  private _materialiseSplitBase(state: GridState): void {
    if (state.splitAccumulatedBase === undefined) return;
    const base = new Decimal(state.splitAccumulatedBase);
    if (base.gt(0)) {
      if (!state.splitAccountingApplied) {
        this._addFee(new Decimal(state.splitAccumulatedFee ?? 0));
      }
      state.levels[0].positions.push({
        id: "unplaced-split",
        baseHeld: base.toString(),
        fillCost: new Decimal(state.splitAccumulatedAmount ?? 0).toString(),
        slotQuote: state.quotePerLevel,
        sellOrderId: null,
      });
    }
    this._clearSplitExecutionState();
    this._saveGridState(state);
  }

  private async _reportSellOff(
    state: GridState,
    prices: {
      marketPrice: Decimal | null;
      priceNow: Decimal | null;
      triggerPrice: Decimal | null;
      resumed: boolean;
    },
    summary: SellOffSummary,
    complete: boolean,
  ): Promise<void> {
    const cs = this._cs;
    const base = state.pair.split("-")[0] ?? "";
    const trigger =
      prices.triggerPrice ?? (prices.resumed ? null : prices.marketPrice);
    const cause =
      this._haltReason === "rejected-orders"
        ? `EMERGENCY STOP after ${MAX_REJECTIONS} rejected orders`
        : "STOP LOSS triggered";
    const headline =
      (trigger ? `${cause} at ${fmtPrice(trigger, cs)}` : cause) +
      (prices.resumed
        ? complete
          ? ", sale finished after a restart"
          : prices.priceNow
            ? `, price now ${fmtPrice(prices.priceNow, cs)}`
            : ""
        : "");
    const held = state.levels
      .flatMap((level) => level.positions)
      .reduce((sum, position) => sum.plus(position.baseHeld), new Decimal(0));
    const sold =
      `Sold ${summary.soldBase} ${base}` +
      (summary.soldBase.gt(0) && !summary.unpricedFill
        ? ` at avg ${fmtPrice(summary.soldQuote.div(summary.soldBase), cs)}`
        : "");
    const outcome = complete
      ? `${sold}.` +
        (summary.writtenOff.gt(0)
          ? ` ${summary.writtenOff} ${base} was too small to sell and stays in the wallet.`
          : "")
      : `${sold}, still holding ${held} ${base}.${state.halt?.orderId ? " The last sale sent isn't confirmed yet." : ""} The sale will finish on the next start.`;
    const reason = complete ? "" : (this._sellOffError ?? "");
    const replacements =
      this._untrackedReplacements > 0
        ? `\n${untrackedReplacementsNote(this._untrackedReplacements)}`
        : "";
    const cancelled =
      summary.cancelled > 0
        ? `Cancelled ${summary.cancelled} grid order${summary.cancelled === 1 ? "" : "s"}. `
        : "";
    this._sellOffMessage =
      `Grid Bot ${state.pair}: ${headline}. ${cancelled}${outcome} ` +
      `Realized P&L: ${fmtSignedPnl(new Decimal(state.stats.realizedPnl), cs)}` +
      replacements +
      (reason ? `\nLast error: ${reason}` : "");
    try {
      await this._notify(this._sellOffMessage);
      if (this._statusReporter) {
        await this._statusReporter.flush(this._renderStatusCard());
        state.statusMessages = this._statusReporter.snapshot();
        if (!complete) this._saveGridState(state);
      }
    } catch (err) {
      this._lastError = `Reporting failed: ${err instanceof Error ? err.message : String(err)}`;
    }
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
      const executionPrice = this._executionPrice(order, fallbackPrice);
      const filledAmount = order.filled_amount
        ? new Decimal(order.filled_amount)
        : filledQty.times(executionPrice);
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
    return new Decimal(order.filled_quantity).times(
      this._executionPrice(order, fallbackPrice),
    );
  }

  private _executionPrice(
    order: OrderDetails,
    fallbackPrice: Decimal,
  ): Decimal {
    for (const rawPrice of [order.average_fill_price, order.price]) {
      if (!rawPrice) continue;
      try {
        const price = new Decimal(rawPrice);
        if (price.isFinite() && price.gt(0)) return price;
      } catch {}
    }
    return fallbackPrice;
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

  private async _placeGridOrder(
    params: PlaceOrderParams,
  ): Promise<OrderPlacementResult> {
    const clientOrderId = params.clientOrderId;
    const firstSend =
      !!clientOrderId && !this._unansweredSince.has(clientOrderId);
    if (firstSend) this._unansweredSince.set(clientOrderId, Date.now());
    let response: Awaited<ReturnType<RevolutXClient["placeOrder"]>>;
    try {
      response = await this._rateLimiter.place(
        () => this._client!.placeOrder(params),
        () => this._refuseWhenStopping(),
      );
    } catch (err) {
      if (firstSend && err instanceof OrderNotSentError) {
        this._unansweredSince.delete(clientOrderId);
      }
      throw err;
    }
    if (clientOrderId && response.data.state !== "rejected") {
      this._unansweredSince.delete(clientOrderId);
    }
    return response.data;
  }

  private _buySlot(level: GridLevelState): string {
    return `buy:${level.index}`;
  }

  private _sellSlot(position: GridLevelPosition): string {
    return `sell:${position.id}`;
  }

  private _slotOf(target: TrackedOrder): string {
    return target.position
      ? this._sellSlot(target.position)
      : this._buySlot(target.level);
  }

  private _targetPrice(target: TrackedOrder): string {
    if (!target.position) return target.level.price;
    return (this._state!.levels[target.level.index + 1] ?? target.level).price;
  }

  private _addOpenBuyFill(order: Pick<Order, "filled_quantity">): void {
    this._openBuyFills = this._openBuyFills.plus(order.filled_quantity || 0);
  }

  private _rememberClientOrderId(
    target: TrackedOrder,
    clientOrderId: string,
  ): void {
    if (!clientOrderId) return;
    if (target.position) {
      target.position.sellClientOrderId ??= clientOrderId;
      return;
    }
    (target.level.buyClientOrderIds ??= {})[target.orderId] ??= clientOrderId;
  }

  private _recordReadOrder(
    target: TrackedOrder,
    order: Pick<Order, "id" | "status" | "client_order_id" | "filled_quantity">,
  ): void {
    this._rememberClientOrderId(target, order.client_order_id);
    this._recordFoundOrder(this._slotOf(target), order);
  }

  private _recordFoundOrder(
    slot: string,
    order: Pick<Order, "id" | "status" | "client_order_id" | "filled_quantity">,
  ): void {
    this._noLongerMissing(order.id);
    this._noLongerMissing(order.client_order_id);
    if (
      RESTING_STATUSES.has(order.status) ||
      new Decimal(order.filled_quantity || 0).gt(0)
    ) {
      this._placementHealth.confirmed(slot, order.id);
    }
  }

  private _recordListedOrder(
    target: TrackedOrder,
    order: Pick<Order, "id" | "status" | "client_order_id">,
  ): void {
    this._rememberClientOrderId(target, order.client_order_id);
    this._noLongerMissing(order.id);
    if (RESTING_STATUSES.has(order.status)) {
      this._placementHealth.confirmed(this._slotOf(target), order.id);
    }
  }

  private _countRejection(
    slot: string,
    clientOrderId: string,
    side: "buy" | "sell",
    price: string,
  ): void {
    if (this._state!.halt) return;
    const rejections = this._placementHealth.rejected(slot, clientOrderId);
    if (rejections === null) return;
    if (rejections >= MAX_REJECTIONS) {
      throw new OrderRejectedError(
        side,
        price,
        `was rejected ${MAX_REJECTIONS} times`,
      );
    }
    this._warnings.push(
      `${side === "buy" ? "Buy" : "Sell"} @${price} rejected, retrying (${rejections + 1}/${MAX_REJECTIONS})`,
    );
  }

  private async _replaceBuy(
    level: GridLevelState,
    orderId: string,
    clientOrderId?: string,
  ): Promise<void> {
    const quote = level.buyOrderQuoteSizes?.[orderId];
    this._removeBuyOrder(level, orderId);
    await this._placeBuyOrAlert(
      level,
      quote ? new Decimal(quote) : undefined,
      clientOrderId,
    );
  }

  private async _handleUnlistedBuy(target: TrackedOrder): Promise<void> {
    const { level, orderId } = target;
    const plan = await this._planUnlisted(
      target,
      level.buyClientOrderIds?.[orderId],
    );
    if (plan.action === "wait") return;
    this._noLongerMissing(orderId);
    if (plan.action === "replace") {
      this._noteUnlistedReplaced(target);
      await this._replaceBuy(level, orderId);
      return;
    }
    this._warnings.push(
      `Buy @${level.price} not listed by the exchange for 5 minutes, sending it again under its own client order ID`,
    );
    this._lookUpFromGridStart(plan.clientOrderId);
    await this._replaceBuy(level, orderId, plan.clientOrderId);
  }

  private async _handleUnlistedSell(target: TrackedOrder): Promise<void> {
    const { position } = target;
    if (!position) return;
    const plan = await this._planUnlisted(target, position.sellClientOrderId);
    if (plan.action === "wait") return;
    this._noLongerMissing(target.orderId);
    if (plan.action === "replace") {
      this._noteUnlistedReplaced(target);
      this._clearSellOrder(position);
    } else {
      this._warnings.push(
        `Sell @${this._targetPrice(target)} not listed by the exchange for 5 minutes, sending it again under its own client order ID`,
      );
      position.sellOrderId = null;
      position.sellClientOrderId = plan.clientOrderId;
      this._lookUpFromGridStart(plan.clientOrderId);
    }
    this._saveGridState(this._state!);
  }

  private async _planUnlisted(
    target: TrackedOrder,
    savedClientOrderId: string | undefined,
  ): Promise<UnlistedPlan> {
    if (savedClientOrderId) {
      return { action: "resend", clientOrderId: savedClientOrderId };
    }
    const { orderId } = target;
    const holdOver = this._noteMissing(orderId) >= UNIDENTIFIED_HOLD_MS;
    if (this._unidentified.has(orderId) && !holdOver) return { action: "wait" };
    if ((this._historyRetryAt.get(orderId) ?? 0) > Date.now()) {
      return { action: "wait" };
    }
    let found: string | undefined;
    try {
      found = await this._clientOrderIdInHistory(orderId);
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._historyRetryAt.set(orderId, Date.now() + HISTORY_RETRY_MS);
      this._warnings.push(
        `Check ${target.position ? "sell" : "buy"} #${target.level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
      );
      return { action: "wait" };
    }
    this._historyRetryAt.delete(orderId);
    if (found) return { action: "resend", clientOrderId: found };
    if (holdOver) return { action: "replace" };
    this._unidentified.add(orderId);
    void this._notify(this._unidentifiedMessage(target));
    return { action: "wait" };
  }

  private _unidentifiedMessage(target: TrackedOrder): string {
    const side = target.position ? "sell" : "buy";
    const parts = [
      `Grid Bot ${this._config.pair}: the ${side} at ${this._cs}${this._targetPrice(target)} (order ${target.orderId}) isn't listed by the exchange, and its client order ID is unknown, so the bot doesn't send it again.`,
      `Check the ${this._config.pair} orders in the Revolut X app.`,
      `If it doesn't show up within 24 hours of going missing, the bot places a new ${side}.`,
    ];
    if (this._config.trailingUp) parts.push("Trailing up waits until then.");
    return parts.join(" ");
  }

  private _noteUnlistedReplaced(target: TrackedOrder): void {
    const side = target.position ? "sell" : "buy";
    const price = this._targetPrice(target);
    this._warnings.push(
      `${side === "buy" ? "Buy" : "Sell"} @${price} not listed by the exchange for 24 hours, client order ID unknown, placing a new ${side}`,
    );
    void this._notify(
      `Grid Bot ${this._config.pair}: the ${side} at ${this._cs}${price} (order ${target.orderId}) was not listed by the exchange for 24 hours, so the bot stops waiting for it and places a new ${side}.`,
    );
  }

  private async _clientOrderIdInHistory(
    orderId: string,
  ): Promise<string | undefined> {
    const orders = await (this._tickHistory ??= this._listOrders());
    return orders.find((order) => order.id === orderId)?.client_order_id;
  }

  private _lookUpFromGridStart(clientOrderId: string): void {
    this._unansweredSince.set(
      clientOrderId,
      this._gridHistoryStart() + ORDER_LOOKUP_LOOKBACK_MS,
    );
  }

  private _clearPendingBuy(level: GridLevelState, clientOrderId: string): void {
    level.pendingBuyClientOrderIds = (
      level.pendingBuyClientOrderIds ?? []
    ).filter((pendingId) => pendingId !== clientOrderId);
    if (level.pendingBuyQuoteSizes) {
      delete level.pendingBuyQuoteSizes[clientOrderId];
    }
  }

  private _dropBuyOrder(level: GridLevelState, orderId: string): void {
    const quote = level.buyOrderQuoteSizes?.[orderId];
    if (quote) this._returnToSlot(level, quote);
    this._removeBuyOrder(level, orderId);
  }

  private _returnToSlot(level: GridLevelState, quote: Decimal.Value): void {
    const position = level.positions[0];
    if (!position) return;
    position.slotQuote = this._slotQuote(position).plus(quote).toString();
  }

  private _removeBuyOrder(level: GridLevelState, orderId: string): void {
    level.buyOrderIds = level.buyOrderIds.filter((id) => id !== orderId);
    if (level.buyOrderQuoteSizes) {
      delete level.buyOrderQuoteSizes[orderId];
    }
    if (level.buyClientOrderIds) {
      delete level.buyClientOrderIds[orderId];
    }
  }

  private _hasUnresolvedPlacementIntents(): boolean {
    if (!this._state) return false;
    return (
      (!!this._state.splitClientOrderId && !this._state.splitOrderId) ||
      !!this._state.halt ||
      Object.keys(this._state.missingSince ?? {}).length > 0 ||
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
  ): {
    position: GridLevelPosition | null;
    remainingQuote: Decimal;
  } {
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
        slotQuote: submittedQuote.toString(),
        sellOrderId: null,
      };
      level.positions.push(position);
      this._state!.stats.totalBuys++;
      this._addFee(feeQuote);
      this._logTrade(
        "buy",
        this._executionPrice(order, fallbackPrice).toString(),
        netBase.toString(),
        order.id,
        undefined,
        feeQuote.toString(),
      );
    }
    this._saveGridState(this._state!);
    return { position, remainingQuote };
  }

  private _shrinkSlot(
    position: GridLevelPosition | null,
    quote: Decimal,
  ): void {
    if (!position) return;
    position.slotQuote = this._slotQuote(position).minus(quote).toString();
  }

  private async _placeRemainingBuy(
    level: GridLevelState,
    quoteSize: Decimal,
    slotOwner: GridLevelPosition | null,
  ): Promise<void> {
    if (!this._isPlaceableBuy(level, quoteSize)) return;
    this._shrinkSlot(slotOwner, quoteSize);
    await this._placeBuyOrder(level, quoteSize);
  }

  private _isPlaceableBuy(level: GridLevelState, quoteSize: Decimal): boolean {
    const constraints = this._getOrderConstraints();
    if (quoteSize.lt(constraints.minQuote)) return false;
    const sellLevel = this._state!.levels[level.index + 1];
    try {
      normalizeBaseOrderSize(
        quoteSize.div(level.price),
        constraints,
        this._config.stopLoss
          ? new Decimal(this._config.stopLoss)
          : sellLevel
            ? new Decimal(sellLevel.price)
            : undefined,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async _processTerminalBuy(
    level: GridLevelState,
    order: OrderDetails,
    notify: boolean,
    replaceOrders = true,
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
      if (sellLevel && replaceOrders) {
        await this._placeSellOnLevel(sellLevel, settlement.position);
      }
      if (notify) {
        const base = this._config.pair.split("-")[0] ?? "";
        const feeQuote = this._feeQuote(order, levelPrice);
        const feeStr = feeQuote.gt(0)
          ? ` | fee ${this._cs}${feeQuote.toFixed(2)}`
          : "";
        void this._notify(
          `Grid Bot ${this._config.pair}: BUY filled @ ${this._cs}${this._executionPrice(order, levelPrice)} | ${settlement.position.baseHeld} ${base}${feeStr}`,
        );
      }
    }
    if (replaceOrders && settlement.remainingQuote.gt(0)) {
      try {
        await this._placeRemainingBuy(
          level,
          settlement.remainingQuote,
          settlement.position,
        );
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._alertBuyFailure(level, settlement.remainingQuote, err);
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
    replaceOrders = true,
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
    const fillPrice = this._executionPrice(order, sellPrice);
    this._logTrade(
      "sell",
      fillPrice.toString(),
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
      void this._notify(
        `Grid Bot ${this._config.pair}: SELL filled @ ${this._cs}${fillPrice} | ` +
          `${settlement.quantity} ${base} | profit ${fmtSignedPnl(settlement.profit, this._cs)}${feeStr} | ` +
          `total P&L: ${fmtSignedPnl(new Decimal(this._state!.stats.realizedPnl), this._cs)}`,
      );
    }

    if (replaceOrders && settlement.remainingBase.gt(0)) {
      await this._placeSellOnLevel(sellLevel, position);
    }

    const rebuyQuote = settlement.rebuyQuote;
    if (replaceOrders && rebuyQuote.gt(0)) {
      try {
        await this._placeRemainingBuy(
          level,
          rebuyQuote,
          settlement.remainingBase.gt(0) ? position : null,
        );
      } catch (err) {
        rethrowIfInsecureKey(err);
        this._alertBuyFailure(level, rebuyQuote, err);
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
    const leftoverBase = heldBase.minus(settledBase);
    const closesPosition =
      !leftoverBase.gt(0) || !this._canSell(leftoverBase, fallbackPrice);
    const settledCostBasis = closesPosition
      ? fullCostBasis
      : fullCostBasis.times(settledBase).div(heldBase);
    const rebuyQuote = this._rebuyQuote(
      position,
      settledBase.div(heldBase),
      closesPosition,
    );

    if (closesPosition) {
      level.positions = level.positions.filter(
        (candidate) => candidate !== position,
      );
    } else {
      position.baseHeld = leftoverBase.toString();
      position.fillCost = fullCostBasis.minus(settledCostBasis).toString();
      this._clearSellOrder(position);
    }

    return {
      quantity: settledBase,
      feeQuote,
      profit: proceeds.minus(settledCostBasis),
      costBasis: settledCostBasis,
      remainingBase: closesPosition ? new Decimal(0) : leftoverBase,
      rebuyQuote,
    };
  }

  private _canSell(base: Decimal, price: Decimal): boolean {
    let constraints: GridOrderConstraints;
    try {
      constraints = this._getOrderConstraints();
    } catch {
      return true;
    }
    try {
      normalizeBaseOrderSize(base, constraints, price);
      return true;
    } catch {
      return false;
    }
  }

  private _slotQuote(position: GridLevelPosition): Decimal {
    return new Decimal(position.slotQuote ?? this._state!.quotePerLevel);
  }

  private _rebuyQuote(
    position: GridLevelPosition,
    soldShare: Decimal,
    closesPosition: boolean,
  ): Decimal {
    const slot = this._slotQuote(position);
    return closesPosition
      ? slot
      : floorToStep(slot.times(soldShare), this._getQuoteStep());
  }

  private _consumeHeldBase(
    quantity: Decimal,
    eligible?: Set<GridLevelPosition>,
  ): Decimal {
    let remaining = quantity;
    let consumedCost = new Decimal(0);

    for (const level of this._state!.levels) {
      for (const position of [...level.positions]) {
        if (!remaining.gt(0)) {
          return consumedCost;
        }
        if (eligible && !eligible.has(position)) continue;
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
          this._clearSellOrder(position);
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
    const quoteCurrency = this._config.pair.split("-")[1] ?? "";
    state.splitRemainingQuote ??= totalQuote.toString();
    state.splitAccumulatedBase ??= "0";
    state.splitAccumulatedAmount ??= "0";
    state.splitAccumulatedFee ??= "0";
    if (!state.splitOrderId && state.splitClientOrderId) {
      this._log(
        chalk.dim(
          `  Looking up the split buy sent earlier, client order ID ${state.splitClientOrderId}...`,
        ),
      );
      const found = (await this._ordersByClientOrderId()).get(
        state.splitClientOrderId,
      );
      if (found) {
        state.splitOrderId = found.id;
        this._saveGridState(state);
      }
    }
    if (state.splitOrderId) {
      state.splitOrderQuoteSize ??= state.splitRemainingQuote;
    }

    while (new Decimal(state.splitRemainingQuote).gte(constraints.minQuote)) {
      if (!state.splitOrderId) {
        if (this._isStopping()) throw new OrderNotSentError();
        const newIntent = !state.splitClientOrderId;
        const clientOrderId = (state.splitClientOrderId ??= randomUUID());
        state.splitOrderQuoteSize ??= state.splitRemainingQuote;
        this._saveGridState(state);
        this._log(
          chalk.dim(
            `  Placing market buy for ${state.splitOrderQuoteSize} ${quoteCurrency}...`,
          ),
        );
        try {
          const orderResponse = await this._rateLimiter.place(
            () =>
              this._client!.placeOrder({
                symbol: this._config.pair,
                side: "buy",
                clientOrderId,
                market: { quoteSize: state.splitOrderQuoteSize },
              }),
            () => this._refuseWhenStopping(),
          );
          state.splitOrderId = orderResponse.data.venue_order_id;
        } catch (err) {
          if (err instanceof OrderNotSentError && newIntent) {
            state.splitClientOrderId = undefined;
            state.splitOrderQuoteSize = undefined;
            this._saveGridState(state);
          }
          if (isDuplicateClientOrderIdError(err)) {
            throw new Error(
              `The split buy ${clientOrderId} was already sent, but the exchange doesn't list it yet. Start again in a few minutes.`,
              { cause: err },
            );
          }
          const doubt = placementDoubt(err);
          if (!doubt) throw err;
          throw new Error(
            `The split buy may have been placed, but ${doubt}. Client order ID: ${clientOrderId}. Run the same command again. It looks the buy up before sending anything.`,
            { cause: err },
          );
        }
        this._saveGridState(state);
        this._log(
          chalk.dim(
            `  Market buy placed: ${state.splitOrderQuoteSize} ${quoteCurrency}. Waiting for fill...`,
          ),
        );
      }

      const terminalOrder = await this._awaitTerminal(state.splitOrderId);
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

      this._recordSplitFill(terminalOrder);
    }

    return {
      base: new Decimal(state.splitAccumulatedBase),
      cost: new Decimal(state.splitAccumulatedAmount),
      fee: new Decimal(state.splitAccumulatedFee),
    };
  }

  private _recordSplitFill(terminalOrder: OrderDetails): void {
    const state = this._state!;
    const constraints = this._getOrderConstraints();
    const fallbackPrice = new Decimal(state.gridPrice);
    const {
      baseReceived: filledBase,
      quoteCost,
      feeQuote,
    } = this._buyEconomics(terminalOrder, fallbackPrice);
    const filledAmount = this._filledAmount(terminalOrder, fallbackPrice);
    const submittedQuote = new Decimal(
      state.splitOrderQuoteSize ??
        this._filledAmount(terminalOrder, fallbackPrice),
    );
    state.splitAccumulatedBase = new Decimal(state.splitAccumulatedBase ?? 0)
      .plus(filledBase)
      .toString();
    state.splitAccumulatedAmount = new Decimal(
      state.splitAccumulatedAmount ?? 0,
    )
      .plus(quoteCost)
      .toString();
    state.splitAccumulatedFee = new Decimal(state.splitAccumulatedFee ?? 0)
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
    if (this._isStopping()) return;
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
      takerFeeRate: TAKER_FEE_RATE,
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

    if (this._isStopping()) {
      this._saveGridState(this._state);
      return;
    }

    // --- Place initial buy orders ---
    const buyLevels = plan.buyLevelIndices.map((index) => levels[index]);
    let buysPlaced = 0;
    const errors: string[] = [];
    this._log(chalk.dim(`  Placing ${buyLevels.length} initial buy orders...`));
    const buyResults = await Promise.allSettled(
      buyLevels.map((level) => this._placeBuyOrder(level, quotePerLevel)),
    );
    if (this._isStopping()) {
      this._saveGridState(this._state);
      return;
    }
    buyResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        buysPlaced++;
        return;
      }
      rethrowIfInsecureKey(result.reason);
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      errors.push(`buy @${buyLevels[index].price}: ${message}`);
    });

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

        const splitPositions = sortedSellLevelIndices.map(
          (sellIdx, allocationIndex) => {
            const sellLevel = levels[sellIdx];
            const buyLevel = levels[sellIdx - 1];
            const baseForLevel = baseByLevel[allocationIndex];
            const costForLevel = totalSplitCost
              ? totalSplitCost.times(baseForLevel).div(allocatedBase)
              : quotePerLevel;
            const position: GridLevelPosition = {
              id: `split-${sellIdx}`,
              baseHeld: baseForLevel.toString(),
              fillCost: costForLevel.toString(),
              slotQuote: quotePerLevel.toString(),
              sellOrderId: null,
            };
            buyLevel.positions.push(position);
            return { sellLevel, position };
          },
        );
        this._state.initializing = false;
        this._clearSplitExecutionState();
        this._saveGridState(this._state);

        await Promise.allSettled(
          splitPositions.map(async ({ sellLevel, position }) => {
            await this._placeSellOnLevel(sellLevel, position);
            if (position.sellOrderId) {
              sellsPlaced++;
              this._saveGridState(this._state!);
            }
          }),
        );
        if (this._isStopping()) {
          this._saveGridState(this._state);
          return;
        }

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

    this._log(chalk.dim("  Grid initialized and state saved.\n"));
  }

  // --------------- reconciliation ---------------

  private async _reconcileAndInit(savedState: GridState): Promise<void> {
    const config = this._config;
    const client = this._client!;

    this._log(chalk.dim("\n  Saved state found. Resuming grid..."));

    const constraints = this._getOrderConstraints();
    if (!savedState.halt) {
      this._validateSavedStateOrderConstraints(savedState, constraints);
    }

    // Phase 1: Adopt saved state as-is
    this._state = savedState;

    // Update mutable config fields (everything else validated in run())
    this._state.config.intervalSec = config.intervalSec;

    const quoteStep = constraints.quoteStep;
    const baseStep = constraints.baseStep;
    this._state.quotePrecision = quoteStep.toString();
    this._state.basePrecision = baseStep.toString();

    if (this._state.halt) {
      await this._liquidate(this._state.halt.reason);
      return;
    }

    // Phase 2: Verify each saved order against the exchange
    let buysFilled = 0;
    let sellsFilled = 0;
    let ordersKept = 0;
    let ordersGone = 0;
    let ordersReplaced = 0;
    let ordersUnlisted = 0;
    let ordersHeld = 0;
    const countReplaced = (order: OrderDetails): boolean => {
      if (outsideChange(order) !== "replaced") return false;
      ordersReplaced++;
      this._untrackedReplacements++;
      return true;
    };
    const countClosed = (order: OrderDetails) => {
      if (!countReplaced(order)) ordersGone++;
    };
    const settledBuyLevelIndices = new Set<number>();
    const settledSellSourceIndices = new Set<number>();
    const isTerminalPartialFill = async (order: OrderDetails) =>
      order.status === PARTIALLY_FILLED_STATUS &&
      !(await this._isOrderActive(order.id));

    const savedOrderIds = new Set(
      this._trackedOrders(this._state).map((target) => target.orderId),
    );
    const resumed = await this._resumePendingPlacements();
    ordersHeld += this._pendingIntents().filter((intent) =>
      this._isUsed(intent.clientOrderId),
    ).length;
    const trackedOrders = this._trackedOrders(this._state);
    const ordersResent = trackedOrders.filter((target) =>
      resumed.resent.has(target.orderId),
    ).length;
    const ordersRenewed: Partial<Record<ClosedPendingOrder, number>> = {};
    for (const target of trackedOrders) {
      const closedAs = resumed.renewed.get(target.orderId);
      if (closedAs)
        ordersRenewed[closedAs] = (ordersRenewed[closedAs] ?? 0) + 1;
    }
    const ordersToVerify = trackedOrders.filter(
      (target) =>
        savedOrderIds.has(target.orderId) || resumed.found.has(target.orderId),
    );

    for (const target of ordersToVerify) {
      if (target.position || !this._isStillTracked(target)) continue;
      const { level, orderId: buyOrderId } = target;
      if (buyOrderId.startsWith("dry-")) {
        ordersKept++;
        continue;
      }
      try {
        const resp = await this._rateLimiter.query(() =>
          client.getOrder(buyOrderId),
        );
        const order = resp.data;
        this._recordReadOrder(target, order);
        if (
          FILLED_STATUSES.has(order.status) ||
          (DEAD_STATUSES.has(order.status) && this._hasFilledQuantity(order)) ||
          (await isTerminalPartialFill(order))
        ) {
          countReplaced(order);
          if (await this._processTerminalBuy(level, order, false)) {
            buysFilled++;
            settledBuyLevelIndices.add(level.index);
          }
        } else if (DEAD_STATUSES.has(order.status)) {
          if (this._holdRejectedOrder(target, order)) {
            ordersHeld++;
          } else {
            this._dropBuyOrder(level, buyOrderId);
            countClosed(order);
          }
        } else {
          ordersKept++;
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (err instanceof NotFoundError) {
          this._noteMissing(buyOrderId);
          ordersUnlisted++;
          continue;
        }
        throw new Error(
          `Unable to reconcile buy order ${buyOrderId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const target of ordersToVerify) {
      const pos = target.position;
      if (!pos || !this._isStillTracked(target)) continue;
      const { level, orderId: sellOrderId } = target;
      const sellLevel = this._state.levels[level.index + 1];
      if (sellOrderId.startsWith("dry-")) {
        ordersKept++;
        continue;
      }
      try {
        const resp = await this._rateLimiter.query(() =>
          client.getOrder(sellOrderId),
        );
        const order = resp.data;
        this._recordReadOrder(target, order);
        if (
          FILLED_STATUSES.has(order.status) ||
          (DEAD_STATUSES.has(order.status) && this._hasFilledQuantity(order)) ||
          (await isTerminalPartialFill(order))
        ) {
          countReplaced(order);
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
          if (this._holdRejectedOrder(target, order)) {
            ordersHeld++;
          } else {
            this._clearSellOrder(pos);
            countClosed(order);
          }
        } else {
          ordersKept++;
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (err instanceof NotFoundError) {
          this._noteMissing(sellOrderId);
          ordersUnlisted++;
          continue;
        }
        throw new Error(
          `Unable to reconcile sell order ${sellOrderId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const restoringInitialization = this._state.initializing === true;

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
      }
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
        const splitPositions = sellLevelsToRestore.map((sellLevel) => {
          const buyLevel = this._state!.levels[sellLevel.index - 1];
          const allocationIndex = sellLevel.index - sellLevels[0].index;
          const baseForLevel = baseByLevel[allocationIndex];
          const costForLevel = totalSplitCost
            .times(baseForLevel)
            .div(allocatedBase);
          const existingPosition = buyLevel.positions.find(
            (position) =>
              position.id.startsWith("split-") && !position.sellOrderId,
          );
          const position: GridLevelPosition = existingPosition ?? {
            id: `split-reconcile-${sellLevel.index}`,
            baseHeld: baseForLevel.toString(),
            fillCost: costForLevel.toString(),
            slotQuote: this._state!.quotePerLevel,
            sellOrderId: null,
          };
          if (!existingPosition) {
            buyLevel.positions.push(position);
          }
          return { sellLevel, position };
        });
        this._state.initializing = false;
        this._clearSplitExecutionState();
        this._saveGridState(this._state);

        const sellResults = await Promise.allSettled(
          splitPositions.map(async ({ sellLevel, position }) => {
            await this._placeSellOnLevel(sellLevel, position);
            if (position.sellOrderId) {
              sellsPlaced++;
              this._saveGridState(this._state!);
            }
          }),
        );
        const fatalSellError = sellResults.find(
          (result) => result.status === "rejected",
        );
        if (fatalSellError?.status === "rejected") {
          throw fatalSellError.reason;
        }
        this._log(
          chalk.dim(
            `  Sell orders placed: ${sellsPlaced}/${sellLevelsToRestore.length}`,
          ),
        );
      }
    } else if (config.splitInvestment && this._state.splitExecuted) {
      this._log(
        chalk.dim(
          "  Split buy already executed in previous session — skipping.",
        ),
      );
    }

    if (restoringInitialization) {
      const missingBuyLevels = this._state.levels
        .slice(0, this._state.levels.length / 2)
        .filter(
          (level) =>
            level.buyOrderIds.length === 0 &&
            (level.pendingBuyClientOrderIds?.length ?? 0) === 0 &&
            !level.positions.some(
              (position) => !position.id.startsWith("split-"),
            ) &&
            !settledBuyLevelIndices.has(level.index),
        );
      const restoreResults = await Promise.allSettled(
        missingBuyLevels.map((level) => this._placeBuyOrAlert(level)),
      );
      const fatalBuyError = restoreResults.find(
        (result) => result.status === "rejected",
      );
      if (fatalBuyError?.status === "rejected") throw fatalBuyError.reason;
      this._state.initializing = false;
      this._clearSplitExecutionState();
    }

    // Phase 4: Save and summarize
    this._saveGridState(this._state);

    this._log(
      renderReconciliationSummary({
        buysFilled,
        sellsFilled,
        kept: ordersKept,
        gone: ordersGone,
        replaced: ordersReplaced,
        resent: ordersResent,
        renewed: ordersRenewed,
        unlisted: ordersUnlisted,
        held: ordersHeld,
      }),
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
      void this._notify(parts.join(" | "));
    }
  }

  // --------------- main loop ---------------

  private async _loop(): Promise<void> {
    const source = this._priceSource!;
    if (this._running) this._flushPlacementAlerts();
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
        this._noteExchangeDown(this._lastError, err);
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

      if (!this._running) break;
      this._tradeLogStart = this._state?.tradeLog.length ?? 0;

      let tickFailure: unknown = null;
      try {
        this._tickInFlight = this._tick(tick.price);
        await this._tickInFlight;
        this._lastError = null;
      } catch (err) {
        tickFailure = err;
        if (err instanceof OrderRejectedError) {
          this.stop();
          void this._liquidate("rejected-orders").catch(() => undefined);
          throw err;
        }
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

      if (this._ordersUnreachable) {
        this._noteExchangeDown(
          this._lastError ?? "orders could not be read",
          tickFailure,
        );
      } else {
        this._noteExchangeBack();
      }

      try {
        if (this._running) this._flushPlacementAlerts();
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
      label =
        this._haltReason === "rejected-orders"
          ? "Stopped (emergency stop)"
          : "Stopped (stop-loss)";
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
    this._cashShortfall = null;
    this._tickHistory = null;
    this._openBuyFills = new Decimal(0);
    this._pruneMissing(state);
    if (this._persistState) {
      try {
        this._connections = loadConnections().filter((c) => c.enabled);
        this._forgetRemovedConnections();
      } catch (err) {
        this._warnings.push(
          `Telegram connections can't be read, the last known ones are used: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this._currentPrice = currentPrice;

    if (this._config.stopLoss) {
      const stopLossPrice = new Decimal(this._config.stopLoss);
      if (currentPrice.lte(stopLossPrice)) {
        await this._liquidate("stop-loss", currentPrice);
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

    let activeOrders: Map<string, Order>;
    try {
      activeOrders = await this._getActiveOrders();
      this._ordersUnreachable = false;
    } catch (err) {
      this._ordersUnreachable = true;
      throw new Error(
        `Failed to fetch active orders: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const trackedOrders = this._trackedOrders(state);

    for (const target of trackedOrders) {
      if (target.position || !this._isStillTracked(target)) continue;
      const { level, orderId: buyOrderId } = target;
      const listed = activeOrders.get(buyOrderId);
      if (listed) {
        this._recordListedOrder(target, listed);
        this._addOpenBuyFill(listed);
        continue;
      }

      try {
        const resp = await this._rateLimiter.query(() =>
          client.getOrder(buyOrderId),
        );
        const order = resp.data;
        this._recordReadOrder(target, order);
        const openPartialFill =
          order.status === PARTIALLY_FILLED_STATUS &&
          (await this._isOrderActive(order.id));
        if (
          FILLED_STATUSES.has(order.status) ||
          (DEAD_STATUSES.has(order.status) && this._hasFilledQuantity(order)) ||
          (order.status === PARTIALLY_FILLED_STATUS && !openPartialFill)
        ) {
          this._noteChangedOutside(order);
          await this._processTerminalBuy(level, order, true);
        } else if (DEAD_STATUSES.has(order.status)) {
          if (!this._holdRejectedOrder(target, order)) {
            this._noteChangedOutside(order);
            await this._replaceBuy(level, buyOrderId);
          }
        } else if (openPartialFill) {
          this._addOpenBuyFill(order);
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (err instanceof NotFoundError) {
          if (this._noteMissing(buyOrderId) >= UNCONFIRMED_GRACE_MS) {
            await this._handleUnlistedBuy(target);
          }
          continue;
        }
        this._warnings.push(
          `Check buy #${level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
        );
      }
    }

    for (const target of trackedOrders) {
      const pos = target.position;
      if (!pos || !this._isStillTracked(target)) continue;
      const { level, orderId: sellOrderId } = target;
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      const listed = activeOrders.get(sellOrderId);
      if (listed) {
        this._recordListedOrder(target, listed);
        continue;
      }

      try {
        const resp = await this._rateLimiter.query(() =>
          client.getOrder(sellOrderId),
        );
        const order = resp.data;
        this._recordReadOrder(target, order);
        if (
          FILLED_STATUSES.has(order.status) ||
          (DEAD_STATUSES.has(order.status) && this._hasFilledQuantity(order)) ||
          (order.status === PARTIALLY_FILLED_STATUS &&
            !(await this._isOrderActive(order.id)))
        ) {
          this._noteChangedOutside(order);
          await this._processTerminalSell(level, sellLevel, pos, order, true);
        } else if (DEAD_STATUSES.has(order.status)) {
          if (!this._holdRejectedOrder(target, order)) {
            this._noteChangedOutside(order);
            this._clearSellOrder(pos);
          }
        }
      } catch (err) {
        rethrowIfInsecureKey(err);
        if (err instanceof NotFoundError) {
          if (this._noteMissing(sellOrderId) >= UNCONFIRMED_GRACE_MS) {
            await this._handleUnlistedSell(target);
          }
          continue;
        }
        this._warnings.push(
          `Check sell #${level.index + 1}: ${err instanceof Error ? err.message : String(err)} (will retry)`,
        );
      }
    }

    await this._sweepPendingIntents(activeOrders);

    const quoteCurrency = this._config.pair.split("-")[1] ?? "";
    let freeCash = this._config.dryRun
      ? null
      : await this._checkBalance(quoteCurrency);
    let buysWaitingForCash = 0;
    let cashNeeded = new Decimal(0);
    for (const level of state.levels) {
      if (
        level.positions.length > 0 ||
        !new Decimal(level.price).lt(new Decimal(state.gridPrice))
      ) {
        continue;
      }
      for (const quoteSize of this._missingBuyQuotes(level)) {
        if (freeCash !== null && freeCash.lt(quoteSize)) {
          buysWaitingForCash++;
          cashNeeded = cashNeeded.plus(quoteSize);
          continue;
        }
        await this._placeBuyOrAlert(level, quoteSize);
        if (freeCash !== null) freeCash = freeCash.minus(quoteSize);
      }
    }
    this._cashShortfall =
      buysWaitingForCash > 0 && freeCash
        ? { buys: buysWaitingForCash, free: freeCash, needed: cashNeeded }
        : null;

    // HELD recovery: positions without a sell order get one placed
    for (const level of state.levels) {
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      for (const pos of level.positions) {
        if (pos.sellOrderId) continue;
        if (
          pos.sellClientOrderId &&
          this._awaitsLookup(pos.sellClientOrderId)
        ) {
          continue;
        }
        if (new Decimal(pos.baseHeld).gt(0)) {
          await this._placeSellOnLevel(sellLevel, pos);
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
        const fillCost = ceilToStep(
          filledQty.times(levelPrice),
          this._getQuoteStep(),
        );

        const pos: GridLevelPosition = {
          id: `dry-${randomUUID().slice(0, 8)}`,
          baseHeld: filledQty.toString(),
          fillCost: fillCost.toString(),
          slotQuote:
            level.buyOrderQuoteSizes?.[buyOrderId] ?? state.quotePerLevel,
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
        void this._notify(
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
        const revenue = floorToStep(
          filledQty.times(sellLevelPrice),
          this._getQuoteStep(),
        );
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
        void this._notify(
          `Grid Bot ${this._config.pair}: SELL filled @ ${cs}${sellLevelPrice} | ` +
            `${filledQty} ${base} | profit ${fmtSignedPnl(profit, cs)} | ` +
            `total P&L: ${fmtSignedPnl(new Decimal(state.stats.realizedPnl), cs)} [DRY RUN]`,
        );

        // Place buy back on this level — each sell independently redeploys capital (multi-slot)
        level.buyOrderIds.push(`dry-buy-${randomUUID().slice(0, 8)}`);
      }
    }

    for (const level of state.levels) {
      if (
        level.buyOrderIds.length === 0 &&
        level.positions.length === 0 &&
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

    const pendingId = position.sellClientOrderId;
    if (pendingId && this._isUsed(pendingId)) return;

    if (this._config.dryRun) {
      position.sellOrderId = `dry-sell-${sellLevel.index}`;
      position.sellBaseSize = heldBase.toString();
      return;
    }

    const slot = this._sellSlot(position);
    try {
      const baseAmount = normalizeBaseOrderSize(
        heldBase,
        this._getOrderConstraints(),
        new Decimal(sellLevel.price),
      );
      if (this._isStopping()) return;
      const newIntent = !position.sellClientOrderId;
      const clientOrderId = (position.sellClientOrderId ??= randomUUID());
      position.sellBaseSize = baseAmount.toString();
      this._saveGridState(this._state!);
      let placement: OrderPlacementResult;
      try {
        placement = await this._placeGridOrder({
          symbol: this._config.pair,
          side: "sell",
          clientOrderId,
          limit: {
            price: sellLevel.price,
            baseSize: baseAmount.toString(),
            executionInstructions: ["allow_taker"],
          },
        });
      } catch (err) {
        if (isDuplicateClientOrderIdError(err)) {
          this._holdForLookup(slot, clientOrderId);
          return;
        }
        if (!(err instanceof OrderNotSentError)) throw err;
        if (newIntent) {
          position.sellClientOrderId = undefined;
          position.sellBaseSize = undefined;
          this._saveGridState(this._state!);
        }
        return;
      }
      if (placement.state === "rejected") {
        this._holdForLookup(slot, clientOrderId);
        return;
      }
      const orderId = placement.venue_order_id;
      position.sellOrderId = orderId;
      this._forgetLookup(clientOrderId);
      this._saveGridState(this._state!);
      this._placementHealth.sent(slot, orderId);
    } catch (err) {
      rethrowIfInsecureKey(err);
      const clientOrderId = position.sellClientOrderId;
      if (clientOrderId && placementDoubt(err)) {
        this._noteMissing(clientOrderId);
      }
      const base = this._config.pair.split("-")[0] ?? "";
      this._alertPlacementFailure(
        slot,
        `the sell of ${position.baseHeld} ${base} at ${this._cs}${sellLevel.price}`,
        err,
      );
    }
  }

  private _alertBuyFailure(
    level: GridLevelState,
    quoteSize: Decimal,
    err: unknown,
  ): void {
    this._alertPlacementFailure(
      this._buySlot(level),
      `the buy of ${fmtMoney(quoteSize, this._cs)} at ${this._cs}${level.price}`,
      err,
    );
  }

  private _alertPlacementFailure(
    slot: string,
    order: string,
    err: unknown,
  ): void {
    const failure = retryFailure(err);
    const message = refusalOf(err)
      ? refusedKeyNotice(err, "grid")
      : err instanceof Error
        ? err.message
        : String(err);
    const reason = [message, failure]
      .filter((part): part is string => Boolean(part))
      .map((part) => part.replace(/\.$/, ""))
      .join(". ");
    this._placementHealth.failed(slot, reason, order);
  }

  private _flushPlacementAlerts(): void {
    for (const { order, reason } of this._placementHealth.takeAlerts()) {
      void this._notify(
        `Grid Bot ${this._config.pair}: could not place ${order} (${reason}). The bot keeps retrying.`,
      );
    }
  }

  private _attentionLines(): string[] {
    const state = this._state;
    if (!state || state.halt || this._lifecycle !== "running") return [];
    const waiting = new Map<
      string,
      { side: "buy" | "sell"; price: string; detail: string; count: number }
    >();
    const note = (side: "buy" | "sell", price: string, detail: string) => {
      const key = `${side}|${price}|${detail}`;
      const entry = waiting.get(key);
      if (entry) entry.count++;
      else waiting.set(key, { side, price, detail, count: 1 });
    };
    const unplaced = (slot: string, status: string) => {
      const reason = this._placementHealth.failureReason(slot);
      return reason ? `not placed: ${reason}` : status;
    };
    const missing = state.missingSince ?? {};
    const now = Date.now();
    const unlisted = (orderId: string): string | null => {
      if (this._unidentified.has(orderId)) return UNLISTED_WITHOUT_ID;
      const since = Date.parse(missing[orderId] ?? "");
      return Number.isFinite(since) && now - since >= UNLISTED_NOTICE_MS
        ? NOT_LISTED_YET
        : null;
    };
    for (const level of state.levels) {
      (level.pendingBuyClientOrderIds ?? []).forEach((clientOrderId) =>
        note(
          "buy",
          level.price,
          unplaced(
            this._buySlot(level),
            this._isUsed(clientOrderId) ? REJECTED_LOOKUP : AWAITING_LOOKUP,
          ),
        ),
      );
      for (const orderId of level.buyOrderIds) {
        const detail = unlisted(orderId);
        if (detail) note("buy", level.price, detail);
      }
      const sellLevel = state.levels[level.index + 1];
      if (!sellLevel) continue;
      for (const position of level.positions) {
        if (position.sellOrderId) {
          const detail = unlisted(position.sellOrderId);
          if (detail) note("sell", sellLevel.price, detail);
          continue;
        }
        if (!new Decimal(position.baseHeld).gt(0)) continue;
        const clientOrderId = position.sellClientOrderId;
        note(
          "sell",
          sellLevel.price,
          unplaced(
            this._sellSlot(position),
            !clientOrderId
              ? NOT_PLACED_YET
              : this._isUsed(clientOrderId)
                ? REJECTED_LOOKUP
                : this._awaitsLookup(clientOrderId)
                  ? AWAITING_LOOKUP
                  : NOT_PLACED_YET,
          ),
        );
      }
    }
    const lines: string[] = [];
    if (this._keyRefusal) {
      lines.push(refusedKeyNotice(this._keyRefusal, "grid"));
    }
    if (this._changedOutside) {
      const { cancelled, replaced, lastAt } = this._changedOutside;
      const time = new Date(lastAt).toLocaleTimeString("en-GB", {
        hour12: false,
      });
      if (cancelled > 0) {
        lines.push(
          `${cancelled} order${cancelled === 1 ? "" : "s"} cancelled outside the bot, placed again (last ${time})`,
        );
      }
      if (replaced > 0) {
        lines.push(
          `${replaced} order${replaced === 1 ? "" : "s"} replaced outside the bot, placed again, replacement${replaced === 1 ? "" : "s"} untracked`,
        );
      }
    }
    if (this._cashShortfall) {
      const { buys, free, needed } = this._cashShortfall;
      lines.push(
        `${buys} buy${buys === 1 ? " waits" : "s wait"} for cash: ${fmtMoney(free, this._cs)} free, ${fmtMoney(needed, this._cs)} needed`,
      );
    }
    for (const { side, price, detail, count } of waiting.values()) {
      const orders =
        count === 1 ? (side === "buy" ? "Buy" : "Sell") : `${count} ${side}s`;
      lines.push(`${orders} @${price} ${detail}`);
    }
    return lines;
  }

  private _pendingIntents(): PendingIntent[] {
    const intents: PendingIntent[] = [];
    for (const level of this._state!.levels) {
      for (const clientOrderId of level.pendingBuyClientOrderIds ?? []) {
        intents.push({ clientOrderId, level });
      }
      for (const position of level.positions) {
        if (position.sellClientOrderId && !position.sellOrderId) {
          intents.push({
            clientOrderId: position.sellClientOrderId,
            level,
            position,
          });
        }
      }
    }
    return intents;
  }

  private _isStillPending(intent: PendingIntent): boolean {
    const { clientOrderId, level, position } = intent;
    if (!position) {
      return !!level.pendingBuyClientOrderIds?.includes(clientOrderId);
    }
    return (
      level.positions.includes(position) &&
      position.sellClientOrderId === clientOrderId &&
      !position.sellOrderId
    );
  }

  private _intentSlot(intent: PendingIntent): string {
    return intent.position
      ? this._sellSlot(intent.position)
      : this._buySlot(intent.level);
  }

  private _isUsed(clientOrderId: string): boolean {
    return !!this._state!.usedClientOrderIds?.includes(clientOrderId);
  }

  private _awaitsLookup(clientOrderId: string): boolean {
    return (
      this._isUsed(clientOrderId) ||
      this._state!.missingSince?.[clientOrderId] !== undefined
    );
  }

  private _holdForLookup(slot: string, clientOrderId: string): void {
    if (this._isUsed(clientOrderId)) return;
    (this._state!.usedClientOrderIds ??= []).push(clientOrderId);
    this._placementHealth.adopted(slot);
    this._noLongerMissing(clientOrderId);
    this._noteMissing(clientOrderId);
  }

  private _holdRejectedOrder(
    target: TrackedOrder,
    order: Pick<Order, "status" | "client_order_id" | "filled_quantity">,
  ): boolean {
    const clientOrderId = order.client_order_id;
    if (!clientOrderId || !this._isBareRejection(order)) return false;
    const { level, orderId, position } = target;
    if (position) {
      position.sellOrderId = null;
      position.sellClientOrderId = clientOrderId;
    } else {
      const quote =
        level.buyOrderQuoteSizes?.[orderId] ?? this._state!.quotePerLevel;
      this._removeBuyOrder(level, orderId);
      const pendingIds = (level.pendingBuyClientOrderIds ??= []);
      if (!pendingIds.includes(clientOrderId)) pendingIds.push(clientOrderId);
      (level.pendingBuyQuoteSizes ??= {})[clientOrderId] = quote;
    }
    this._holdForLookup(this._slotOf(target), clientOrderId);
    this._saveGridState(this._state!);
    return true;
  }

  private async _sweepPendingIntents(
    activeOrders: Map<string, Order>,
  ): Promise<void> {
    const listed = new Map<string, Order>();
    for (const order of activeOrders.values()) {
      if (order.client_order_id) listed.set(order.client_order_id, order);
    }
    for (const intent of this._pendingIntents()) {
      const order = listed.get(intent.clientOrderId);
      if (order) await this._resumeIntent(intent, order, true);
    }
    const pending = this._pendingIntents().filter(
      (intent) => !intent.position || this._awaitsLookup(intent.clientOrderId),
    );
    const pendingIds = new Set(pending.map((intent) => intent.clientOrderId));
    for (const clientOrderId of this._pendingMissedOnce) {
      if (!pendingIds.has(clientOrderId)) {
        this._pendingMissedOnce.delete(clientOrderId);
      }
    }
    if (pending.length === 0 || Date.now() < this._pendingSweepAt) return;
    const listedAt = Date.now();
    this._pendingSweepAt = listedAt + PENDING_LOOKUP_MS;
    let orders: Map<string, Order>;
    try {
      orders = await this._ordersByClientOrderId(
        this._lookupStart([...pendingIds]),
      );
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._warnings.push(
        `Order lookup: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const quoteCurrency = this._config.pair.split("-")[1] ?? "";
    let freeQuote: Decimal | null | undefined;
    for (const intent of pending) {
      if (!this._isStillPending(intent)) continue;
      const { clientOrderId, level, position } = intent;
      const order = orders.get(clientOrderId);
      if (order && !this._isBareRejection(order)) {
        await this._resumeIntent(intent, order, true);
        continue;
      }
      if (order) this._holdForLookup(this._intentSlot(intent), clientOrderId);
      if (this._isUsed(clientOrderId)) {
        if (
          this._recordMissing(clientOrderId, this._state!, listedAt) === "gone"
        ) {
          await this._retirePendingIntent(intent);
        }
        continue;
      }
      if (!this._pendingMissedOnce.has(clientOrderId)) {
        this._pendingMissedOnce.add(clientOrderId);
        continue;
      }
      if (position) {
        const sellLevel = this._state!.levels[level.index + 1];
        if (sellLevel) await this._placeSellOnLevel(sellLevel, position);
        continue;
      }
      const quoteSize = this._pendingBuyQuote(level, clientOrderId);
      if (freeQuote === undefined) {
        freeQuote = await this._checkBalance(quoteCurrency);
      }
      if (freeQuote !== null && freeQuote.lt(quoteSize)) {
        this._alertBuyFailure(
          level,
          quoteSize,
          `not enough ${quoteCurrency}, ${fmtMoney(freeQuote, this._cs)} free`,
        );
        continue;
      }
      await this._placeBuyOrAlert(level, quoteSize, clientOrderId);
      if (freeQuote !== null) freeQuote = freeQuote.minus(quoteSize);
    }
  }

  private async _resumeIntent(
    intent: PendingIntent,
    order: Order | undefined,
    resend: boolean,
  ): Promise<ResumedPlacement | null> {
    const { clientOrderId, level, position } = intent;
    if (!position) {
      return this._resumePendingBuy(level, clientOrderId, order, resend);
    }
    const sellLevel = this._state!.levels[level.index + 1];
    if (!sellLevel) return null;
    return this._resumePendingSell(sellLevel, position, order, resend);
  }

  private async _retirePendingIntent(intent: PendingIntent): Promise<void> {
    const { clientOrderId, level, position } = intent;
    this._forgetLookup(clientOrderId);
    if (position) {
      const sellLevel = this._state!.levels[level.index + 1];
      position.sellClientOrderId = undefined;
      position.sellBaseSize = undefined;
      this._saveGridState(this._state!);
      if (!sellLevel) return;
      this._countRejection(
        this._sellSlot(position),
        clientOrderId,
        "sell",
        sellLevel.price,
      );
      await this._placeSellOnLevel(sellLevel, position);
      return;
    }
    const quoteSize = this._pendingBuyQuote(level, clientOrderId);
    this._clearPendingBuy(level, clientOrderId);
    this._saveGridState(this._state!);
    try {
      this._countRejection(
        this._buySlot(level),
        clientOrderId,
        "buy",
        level.price,
      );
    } catch (err) {
      this._returnToSlot(level, quoteSize);
      this._saveGridState(this._state!);
      throw err;
    }
    await this._placeBuyOrAlert(level, quoteSize);
  }

  private async _placeBuyOrAlert(
    level: GridLevelState,
    quoteSize = new Decimal(this._state!.quotePerLevel),
    clientOrderId?: string,
  ): Promise<string | null> {
    try {
      return await this._placeBuyOrder(level, quoteSize, clientOrderId);
    } catch (err) {
      rethrowIfInsecureKey(err);
      this._alertBuyFailure(level, quoteSize, err);
      return null;
    }
  }

  private _pendingBuyQuote(
    level: GridLevelState,
    clientOrderId: string,
  ): Decimal {
    return new Decimal(
      level.pendingBuyQuoteSizes?.[clientOrderId] ?? this._state!.quotePerLevel,
    );
  }

  private async _placeBuyOrder(
    level: GridLevelState,
    quoteSize: Decimal,
    clientOrderId?: string,
  ): Promise<string | null> {
    if (this._config.dryRun) {
      const orderId = `dry-buy-${randomUUID().slice(0, 8)}`;
      level.buyOrderIds.push(orderId);
      return orderId;
    }

    const attemptClientOrderId = clientOrderId ?? randomUUID();
    const minted = clientOrderId === undefined;
    level.pendingBuyQuoteSizes ??= {};
    const persistedQuoteSize = level.pendingBuyQuoteSizes[attemptClientOrderId];
    const requestedQuoteSize = persistedQuoteSize
      ? new Decimal(persistedQuoteSize)
      : quoteSize;
    const pendingIds = (level.pendingBuyClientOrderIds ??= []);
    const newIntent = !pendingIds.includes(attemptClientOrderId);
    if (newIntent && minted && this._isStopping()) {
      this._returnToSlot(level, requestedQuoteSize);
      this._saveGridState(this._state!);
      return null;
    }
    if (newIntent) {
      pendingIds.push(attemptClientOrderId);
      level.pendingBuyQuoteSizes[attemptClientOrderId] =
        requestedQuoteSize.toString();
      this._saveGridState(this._state!);
    }
    let placement: OrderPlacementResult;
    try {
      placement = await this._placeGridOrder({
        symbol: this._config.pair,
        side: "buy",
        clientOrderId: attemptClientOrderId,
        limit: {
          price: level.price,
          quoteSize: requestedQuoteSize.toString(),
          executionInstructions: ["allow_taker"],
        },
      });
    } catch (err) {
      if (isDuplicateClientOrderIdError(err)) {
        this._holdForLookup(this._buySlot(level), attemptClientOrderId);
        return null;
      }
      if (!(err instanceof OrderNotSentError)) throw err;
      if (newIntent && minted) {
        this._clearPendingBuy(level, attemptClientOrderId);
        this._returnToSlot(level, requestedQuoteSize);
        this._saveGridState(this._state!);
      }
      return null;
    }
    const slot = this._buySlot(level);
    if (placement.state === "rejected") {
      this._holdForLookup(slot, attemptClientOrderId);
      return null;
    }
    const orderId = placement.venue_order_id;
    this._clearPendingBuy(level, attemptClientOrderId);
    level.buyOrderQuoteSizes ??= {};
    level.buyOrderQuoteSizes[orderId] = requestedQuoteSize.toString();
    (level.buyClientOrderIds ??= {})[orderId] = attemptClientOrderId;
    if (!level.buyOrderIds.includes(orderId)) {
      level.buyOrderIds.push(orderId);
    }
    this._forgetLookup(attemptClientOrderId);
    this._saveGridState(this._state!);
    this._placementHealth.sent(slot, orderId);
    return orderId;
  }

  private async _resumePendingPlacements(resend = true): Promise<{
    resent: Set<string>;
    renewed: Map<string, ClosedPendingOrder>;
    found: Set<string>;
  }> {
    const resentOrderIds = new Set<string>();
    const renewedOrderIds = new Map<string, ClosedPendingOrder>();
    const foundOrderIds = new Set<string>();
    const note = (placement: ResumedPlacement | null) => {
      if (!placement) return;
      if (placement.closedAs) {
        renewedOrderIds.set(placement.orderId, placement.closedAs);
      } else {
        resentOrderIds.add(placement.orderId);
      }
    };
    const resumed = () => ({
      resent: resentOrderIds,
      renewed: renewedOrderIds,
      found: foundOrderIds,
    });
    const intents = this._pendingIntents();
    if (intents.length === 0) return resumed();
    const ordersByClientOrderId = await this._ordersByClientOrderId();
    for (const order of ordersByClientOrderId.values()) {
      foundOrderIds.add(order.id);
    }
    for (const intent of intents) {
      if (!this._isStillPending(intent)) continue;
      note(
        await this._resumeIntent(
          intent,
          ordersByClientOrderId.get(intent.clientOrderId),
          resend,
        ),
      );
    }
    return resumed();
  }

  private _gridHistoryStart(state = this._state!): number {
    const createdAt = Date.parse(state.createdAt);
    return Number.isFinite(createdAt)
      ? createdAt - ORDER_LOOKUP_LOOKBACK_MS
      : Date.now() - ORDER_LOOKUP_FALLBACK_MS;
  }

  private _lookupStart(clientOrderIds: string[]): number {
    const sentTimes: number[] = [];
    for (const clientOrderId of clientOrderIds) {
      const sentAt = this._unansweredSince.get(clientOrderId);
      if (sentAt === undefined) return this._gridHistoryStart();
      sentTimes.push(sentAt);
    }
    if (sentTimes.length === 0) return this._gridHistoryStart();
    return Math.min(...sentTimes) - ORDER_LOOKUP_LOOKBACK_MS;
  }

  private _forgetLookup(clientOrderId: string): void {
    const state = this._state!;
    if (this._isUsed(clientOrderId)) {
      state.usedClientOrderIds = state.usedClientOrderIds!.filter(
        (usedId) => usedId !== clientOrderId,
      );
    }
    this._pendingMissedOnce.delete(clientOrderId);
    this._unansweredSince.delete(clientOrderId);
    this._noLongerMissing(clientOrderId);
  }

  private async _ordersByClientOrderId(
    historyFrom = this._gridHistoryStart(),
  ): Promise<Map<string, Order>> {
    const byClientOrderId = new Map<string, Order>();
    for (const order of await this._listOrders(historyFrom)) {
      const known = byClientOrderId.get(order.client_order_id);
      if (!known || this._orderRank(order) < this._orderRank(known)) {
        byClientOrderId.set(order.client_order_id, order);
      }
    }
    return byClientOrderId;
  }

  private _orderRank(order: Pick<Order, "status" | "filled_quantity">): number {
    if (this._isBareRejection(order)) return 2;
    return this._isOpenOrFilled(order) ? 0 : 1;
  }

  private _isBareRejection(
    order: Pick<Order, "status" | "filled_quantity">,
  ): boolean {
    return (
      order.status === "rejected" &&
      !new Decimal(order.filled_quantity || 0).gt(0)
    );
  }

  private async _listOrders(
    historyFrom = this._gridHistoryStart(),
  ): Promise<Order[]> {
    const orders = new Map<string, Order>();
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
        orders.set(order.id, order);
      }
      cursor = response.metadata?.next_cursor as string | undefined;
    } while (cursor);
    const endDate = Date.now();
    const historical = await paginateWithDynamicWindows<Order>({
      fetchPage: (startDate, windowEnd, pageCursor, limit) =>
        this._rateLimiter.query(() =>
          this._client!.getHistoricalOrders({
            symbols: [this._config.pair],
            startDate,
            endDate: windowEnd,
            cursor: pageCursor,
            limit,
          }),
        ),
      startDate: historyFrom,
      endDate,
      apiLimit: HISTORICAL_ORDERS_API_LIMIT,
    });
    for (const order of historical) {
      if (!orders.has(order.id)) orders.set(order.id, order);
    }
    return [...orders.values()];
  }

  private _isOpenOrFilled(
    order: Pick<Order, "status" | "filled_quantity">,
  ): boolean {
    return (
      !DEAD_STATUSES.has(order.status) ||
      new Decimal(order.filled_quantity || 0).gt(0)
    );
  }

  private async _resumePendingBuy(
    level: GridLevelState,
    clientOrderId: string,
    order: Order | undefined,
    resend: boolean,
  ): Promise<ResumedPlacement | null> {
    const quoteSize = this._pendingBuyQuote(level, clientOrderId);
    if (!order || this._isBareRejection(order)) {
      if (order) this._holdForLookup(this._buySlot(level), clientOrderId);
      if (!resend) {
        if (this._recordMissing(clientOrderId) === "gone") {
          this._clearPendingBuy(level, clientOrderId);
          this._saveGridState(this._state!);
        }
        return null;
      }
      if (this._isUsed(clientOrderId)) {
        this._noteMissing(clientOrderId);
        return null;
      }
      return placedAgain(
        await this._placeBuyOrAlert(level, quoteSize, clientOrderId),
        null,
      );
    }
    this._forgetLookup(clientOrderId);
    this._clearPendingBuy(level, clientOrderId);
    if (this._isOpenOrFilled(order)) {
      level.buyOrderQuoteSizes ??= {};
      level.buyOrderQuoteSizes[order.id] = quoteSize.toString();
      (level.buyClientOrderIds ??= {})[order.id] = clientOrderId;
      if (!level.buyOrderIds.includes(order.id)) {
        level.buyOrderIds.push(order.id);
      }
      this._saveGridState(this._state!);
      this._placementHealth.adopted(this._buySlot(level));
      this._recordFoundOrder(this._buySlot(level), order);
      return null;
    }
    this._saveGridState(this._state!);
    this._recordFoundOrder(this._buySlot(level), order);
    const closedAs = this._closedAs(order);
    if (!resend) return null;
    return placedAgain(await this._placeBuyOrAlert(level, quoteSize), closedAs);
  }

  private async _resumePendingSell(
    sellLevel: GridLevelState,
    position: GridLevelPosition,
    order: Order | undefined,
    resend: boolean,
  ): Promise<ResumedPlacement | null> {
    const clientOrderId = position.sellClientOrderId;
    if (!order || this._isBareRejection(order)) {
      if (order && clientOrderId) {
        this._holdForLookup(this._sellSlot(position), clientOrderId);
      }
      if (!resend) {
        if (clientOrderId && this._recordMissing(clientOrderId) === "gone") {
          position.sellClientOrderId = undefined;
          position.sellBaseSize = undefined;
          this._saveGridState(this._state!);
        }
        return null;
      }
      if (clientOrderId && this._isUsed(clientOrderId)) {
        this._noteMissing(clientOrderId);
        return null;
      }
      await this._placeSellOnLevel(sellLevel, position);
      return placedAgain(position.sellOrderId ?? null, null);
    }
    if (clientOrderId) this._forgetLookup(clientOrderId);
    if (this._isOpenOrFilled(order)) {
      position.sellOrderId = order.id;
      this._saveGridState(this._state!);
      this._placementHealth.adopted(this._sellSlot(position));
      this._recordFoundOrder(this._sellSlot(position), order);
      return null;
    }
    const closedAs = this._closedAs(order);
    position.sellClientOrderId = undefined;
    position.sellBaseSize = undefined;
    this._saveGridState(this._state!);
    this._recordFoundOrder(this._sellSlot(position), order);
    if (!resend) return null;
    await this._placeSellOnLevel(sellLevel, position);
    return placedAgain(position.sellOrderId ?? null, closedAs);
  }

  // --------------- notifications & logging ---------------

  private _noteChangedOutside(
    order: Pick<OrderDetails, "id" | "status" | "reject_reason">,
  ): void {
    if (this._selfCancelled.has(order.id)) return;
    const change = outsideChange(order);
    if (!change) return;
    if (change === "replaced") this._untrackedReplacements++;
    const seen = this._changedOutside ?? {
      cancelled: 0,
      replaced: 0,
      lastAt: 0,
    };
    this._changedOutside = {
      ...seen,
      [change]: seen[change] + 1,
      lastAt: Date.now(),
    };
  }

  private _closedAs(order: Order): ClosedPendingOrder {
    const change = outsideChange(order);
    if (change === "replaced") this._noteChangedOutside(order);
    return change ?? "rejected";
  }

  private _noteExchangeDown(error: string, cause: unknown): void {
    this._keyRefusal = refusalOf(cause);
    const alert = this._outage.failed(exchangeFault(cause));
    if (!alert) return;
    const subject = `Grid Bot ${this._config.pair}`;
    this._sendOutageAlert(
      alert,
      alert.fault === "refused"
        ? refusedKeyMessage(subject, cause, {
            user: "grid",
            keyLabel: this._keyLabel,
            meanwhile: "Open grid orders stay on the exchange meanwhile.",
          })
        : noDataMessage(subject, alert.minutes, error),
    );
  }

  private _noteExchangeBack(): void {
    this._keyRefusal = null;
    const alert = this._outage.recovered();
    if (!alert) return;
    this._sendOutageAlert(
      alert,
      recoveryMessage(`Grid Bot ${this._config.pair}`, alert),
    );
  }

  private _sendOutageAlert(alert: OutageAlert, message: string): void {
    void this._notify(message).then((delivered) => {
      if (!delivered) this._outage.undelivered(alert);
    });
  }

  private _forgetRemovedConnections(): void {
    const current = new Set(this._connections.map((c) => c.id));
    for (const connectionId of [...this._telegramProblems.keys()]) {
      if (!current.has(connectionId)) {
        this._telegramProblems.delete(connectionId);
      }
    }
  }

  private async _notify(message: string): Promise<boolean> {
    if (this._connections.length === 0) return true;
    const delivered = await Promise.all(
      this._connections.map(async (tc) => {
        const result = await sendWithRetries(tc.bot_token, tc.chat_id, message);
        this._noteTelegram(tc.id, result);
        return result.success;
      }),
    );
    return delivered.includes(true);
  }

  private _noteTelegram(connectionId: string, result: TelegramResult): void {
    if (result.success) {
      this._telegramProblems.delete(connectionId);
    } else {
      this._telegramProblems.set(connectionId, result.error ?? "not delivered");
    }
  }

  private _telegramProblem(): string | null {
    for (const connection of this._connections) {
      const problem = this._telegramProblems.get(connection.id);
      if (problem) return problem;
    }
    return null;
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
      attention: this._attentionLines(),
      warnings: this._warnings,
      telegramConnections: this._connections.length,
      intervalSec: this._config.intervalSec,
      telegramProblem: this._telegramProblem(),
      openBuyFills: this._openBuyFills,
    };

    process.stdout.write("\x1B[2J\x1B[H");
    this._log(renderDashboard(data));
  }
}
