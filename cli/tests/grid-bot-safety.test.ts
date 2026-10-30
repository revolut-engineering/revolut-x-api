import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import {
  AuthenticationError,
  BadRequestError,
  ForbiddenError,
  InsecureKeyPermissionsError,
  NetworkError,
  NotFoundError,
  RevolutXError,
  ServerError,
} from "@revolut/revolut-x-api";
import type { CurrencyPair, Order, OrderDetails } from "@revolut/revolut-x-api";
import { OUTAGE_ALERT_MS } from "../src/engine/outage-watch.js";
import type { TelegramResult } from "../src/engine/notify.js";
import type { TelegramConnection } from "../src/db/store.js";
import { ForegroundGridBot } from "../src/engine/grid-bot.js";
import { loadConnections } from "../src/db/store.js";
import {
  GridStateDamagedError,
  deleteGridState,
  loadGridState,
  saveGridState,
  setAsideGridState,
  type GridLevelPosition,
  type GridLevelState,
  type GridState,
} from "../src/db/grid-store.js";

const SAVED_KEY = vi.hoisted(() => `u8jz${"x".repeat(56)}mxgJ`);

vi.mock("@revolut/revolut-x-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@revolut/revolut-x-api")>()),
  loadConfig: vi.fn(() => ({ api_key: SAVED_KEY })),
}));

const mockSendWithRetries = vi.hoisted(() =>
  vi.fn(async (): Promise<TelegramResult> => ({ success: true })),
);

vi.mock("../src/engine/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/notify.js")>()),
  sendWithRetries: mockSendWithRetries,
}));

vi.mock("../src/db/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/store.js")>()),
  loadConnections: vi.fn(() => []),
}));

vi.mock("../src/db/grid-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/db/grid-store.js")>();
  return {
    ...actual,
    saveGridState: vi.fn(),
    deleteGridState: vi.fn(),
    loadGridState: vi.fn(actual.loadGridState),
    setAsideGridState: vi.fn(() => "/config/grid_state_BTC-USD.json.damaged-1"),
  };
});

const PAIR_INFO: CurrencyPair = {
  base: "BTC",
  quote: "USD",
  base_step: "0.001",
  quote_step: "0.1",
  min_order_size: "0.001",
  max_order_size: "100",
  min_order_size_quote: "1",
  slippage: 0,
  status: "active",
};

function makeState(): GridState {
  return {
    id: "grid",
    pair: "BTC-USD",
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    config: {
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      trailingUp: true,
    },
    splitExecuted: false,
    gridPrice: "100",
    quotePrecision: "1",
    basePrecision: "0.001",
    quotePerLevel: "10",
    levels: ["99", "99.1", "99.2", "100"].map((price, index) => ({
      index,
      price,
      buyOrderIds: index === 0 ? ["buy-1"] : [],
      positions: [],
    })),
    stats: {
      totalBuys: 0,
      totalSells: 0,
      realizedPnl: "0",
      totalFees: "0",
    },
    tradeLog: [],
  };
}

describe("grid bot safety", () => {
  it("restores missing initial buys before resuming an interrupted grid", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "restored-buy" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "open",
        filled_quantity: "0",
        filled_amount: "0",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        limit: expect.objectContaining({ price: "99.1", quoteSize: "10" }),
      }),
    );
    expect(state.initializing).toBe(false);
  });

  it("still starts when a missing first buy can't be restored", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    const placeOrder = vi.fn(async (): Promise<never> => {
      throw new RevolutXError(
        "Insufficient balance of 0 USD, required 10 USD",
        422,
      );
    });
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "open",
        filled_quantity: "0",
        filled_amount: "0",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _placementHealth: {
        takeAlerts: () => Array<{ order: string; reason: string }>;
      };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    const startup = internals._reconcileAndInit(state);

    // then
    await expect(startup).resolves.toBeUndefined();
    expect(state.initializing).toBe(false);
    expect(state.levels[1].pendingBuyClientOrderIds).toHaveLength(1);
    expect(internals._placementHealth.takeAlerts()).toEqual([
      expect.objectContaining({
        reason: "Insufficient balance of 0 USD, required 10 USD",
      }),
    ]);
  });

  it("keeps restoring start-up when a first buy comes back rejected, holding its client order ID", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    let placements = 0;
    const placeOrder = vi.fn(async (request: { clientOrderId: string }) => ({
      data: {
        venue_order_id: `rejected-${++placements}`,
        client_order_id: request.clientOrderId,
        state: "rejected" as const,
      },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: orderId === "buy-1" ? "open" : "rejected",
        filled_quantity: "0",
        filled_amount: "0",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    const startup = internals._reconcileAndInit(state);

    // then
    await expect(startup).resolves.toBeUndefined();
    const sent = placeOrder.mock.calls.map(
      ([request]) => request.clientOrderId,
    );
    expect(sent).toHaveLength(1);
    expect(state.levels[1].pendingBuyClientOrderIds).toEqual(sent);
    expect(state.levels[1].buyOrderIds).toEqual([]);
    expect(state.initializing).toBe(false);
  });

  it("still starts when a split sell can't be restored, and keeps its coins for the next check", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    state.splitExecuted = true;
    state.splitOrderId = "split-order";
    state.config.splitInvestment = true;
    state.levels = ["90", "95", "105", "110"].map((price, index) => ({
      index,
      price,
      buyOrderIds: [],
      positions: [],
    }));
    const placeOrder = vi.fn(async (order: { side: string }) => {
      if (order.side === "sell") {
        throw new RevolutXError("Insufficient balance of 0 BTC", 422);
      }
      return { data: { venue_order_id: "restored-buy" } };
    });
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "filled",
        filled_quantity: "0.4",
        filled_amount: "40",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.1",
      investment: "40",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _placementHealth: {
        takeAlerts: () => Array<{ order: string; reason: string }>;
      };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    const startup = internals._reconcileAndInit(state);

    // then
    await expect(startup).resolves.toBeUndefined();
    const splitPositions = state.levels
      .flatMap((level) => level.positions)
      .filter((position) => position.id.startsWith("split-"));
    const sells = placeOrder.mock.calls.filter(
      ([order]) => order.side === "sell",
    );
    expect(splitPositions).toHaveLength(2);
    expect(sells).toHaveLength(2);
    for (const position of splitPositions) {
      expect(position.sellOrderId).toBeFalsy();
      expect(position.sellClientOrderId).toEqual(expect.any(String));
    }
    expect(internals._placementHealth.takeAlerts()).toHaveLength(2);
    expect(state.initializing).toBe(false);
  });

  it("restores only missing split sell orders after interrupted initialization", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    state.splitExecuted = true;
    state.splitOrderId = "split-order";
    state.config.splitInvestment = true;
    state.levels = ["90", "95", "105", "110"].map((price, index) => ({
      index,
      price,
      buyOrderIds: index === 2 ? ["filled-buy"] : [],
      positions:
        index === 1
          ? [
              {
                id: "split-2",
                baseHeld: "0.2",
                fillCost: "20",
                sellOrderId: "existing-sell",
              },
            ]
          : [],
    }));
    const placeOrder = vi
      .fn()
      .mockResolvedValueOnce({ data: { venue_order_id: "normal-sell" } })
      .mockResolvedValueOnce({ data: { venue_order_id: "restored-sell" } })
      .mockResolvedValue({ data: { venue_order_id: "restored-buy" } });
    const getOrder = vi.fn(async (orderId: string) => ({
      data:
        orderId === "split-order"
          ? {
              id: orderId,
              status: "filled",
              filled_quantity: "0.4",
              filled_amount: "40",
              total_fee: "0",
              fee_currency: "USD",
            }
          : orderId === "filled-buy"
            ? {
                id: orderId,
                status: "filled",
                filled_quantity: "0.1",
                filled_amount: "10",
                total_fee: "0",
                fee_currency: "USD",
              }
            : {
                id: orderId,
                status: "open",
                filled_quantity: "0",
                filled_amount: "0",
                total_fee: "0",
                fee_currency: "USD",
              },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.1",
      investment: "40",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    await internals._reconcileAndInit(state);

    // then
    const sellPlacements = placeOrder.mock.calls.filter(
      ([order]) => order.side === "sell",
    );
    const buyPlacements = placeOrder.mock.calls.filter(
      ([order]) => order.side === "buy",
    );
    expect(sellPlacements).toHaveLength(2);
    expect(buyPlacements).toHaveLength(2);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "sell",
        limit: expect.objectContaining({ baseSize: "0.2", price: "110" }),
      }),
    );
    expect(state.levels[2].positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "filled-buy", baseHeld: "0.1" }),
        expect.objectContaining({
          id: "split-reconcile-3",
          baseHeld: "0.2",
          sellOrderId: "restored-sell",
        }),
      ]),
    );
  });

  it("completes the unfilled remainder of a terminal split market buy", async () => {
    // given
    const state = makeState();
    state.config.splitInvestment = true;
    state.splitOrderId = "partial-split";
    state.splitClientOrderId = "partial-client";
    state.splitOrderQuoteSize = "20";
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "remainder-split" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data:
        orderId === "partial-split"
          ? {
              id: orderId,
              status: "partially_filled",
              filled_quantity: "0.1",
              filled_amount: "10",
              total_fee: "0",
              fee_currency: "USD",
            }
          : {
              id: orderId,
              status: "filled",
              filled_quantity: "0.1",
              filled_amount: "10",
              total_fee: "0",
              fee_currency: "USD",
            },
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        placeOrder: typeof placeOrder;
      };
      _executeSplitMarketBuy: (
        totalQuote: Decimal,
      ) => Promise<{ base: Decimal; cost: Decimal; fee: Decimal }>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    const result = await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(result.base.toString()).toBe("0.2");
    expect(result.cost.toString()).toBe("20");
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        market: { quoteSize: "10" },
      }),
    );
  });

  it("replaces a buy when its paired sell filled while the bot was offline", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: "filled-sell",
      },
    ];
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "replacement-buy" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "filled",
        filled_quantity: "0.1",
        filled_amount: "10.1",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        limit: expect.objectContaining({ price: "99", quoteSize: "10" }),
      }),
    );
    expect(state.levels[0].buyOrderIds).toEqual(["replacement-buy"]);
  });

  it("closes a leftover too small to sell and charges its cost to the sale", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1009",
        fillCost: "10.09",
        sellOrderId: "filled-sell",
        sellBaseSize: "0.1",
      },
    ];
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "replacement-buy" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "filled",
        filled_quantity: "0.1",
        filled_amount: "10.1",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("0.01");
  });

  it("reuses a persisted client order id when recovering a buy placement", async () => {
    // given
    const state = makeState();
    const level = state.levels[0];
    level.buyOrderIds = [];
    level.pendingBuyClientOrderIds = ["pending-client-id"];
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "recovered-buy" },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _client: { placeOrder: typeof placeOrder };
      _placeBuyOrder: (
        level: GridState["levels"][number],
        quoteSize: Decimal,
        clientOrderId: string,
      ) => Promise<string>;
    };
    internals._state = state;
    internals._client = { placeOrder };

    // when
    await internals._placeBuyOrder(
      level,
      new Decimal("10"),
      "pending-client-id",
    );

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "pending-client-id" }),
    );
    expect(level.pendingBuyClientOrderIds).toEqual([]);
    expect(level.buyOrderIds).toEqual(["recovered-buy"]);
  });

  it("re-sends a pending buy with its own client order id while running", async () => {
    // given
    const state = makeState();
    const level = state.levels[0];
    level.buyOrderIds = [];
    level.pendingBuyClientOrderIds = ["pending-client-id"];
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "recovered-buy" },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, unknown>;
      _pendingSweepAt: number;
      _sweepPendingIntents: (activeOrders: Map<string, Order>) => Promise<void>;
    };
    internals._state = state;
    internals._client = {
      placeOrder,
      getActiveOrders: vi.fn(async () => ({ data: [], metadata: {} })),
      getHistoricalOrders: vi.fn(async () => ({ data: [], metadata: {} })),
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };

    // when
    await internals._sweepPendingIntents(new Map());
    internals._pendingSweepAt = 0;
    await internals._sweepPendingIntents(new Map());

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "pending-client-id" }),
    );
    expect(level.buyOrderIds).toEqual(["recovered-buy"]);
  });

  it("tracks a terminal partial buy and replaces only its remainder", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const placeOrder = vi
      .fn()
      .mockResolvedValueOnce({ data: { venue_order_id: "partial-sell" } })
      .mockResolvedValueOnce({ data: { venue_order_id: "remainder-buy" } });
    const getOrder = vi.fn(async (orderId: string) => ({
      data:
        orderId === "buy-1"
          ? {
              id: orderId,
              status: "partially_filled",
              filled_quantity: "0.04",
              filled_amount: "4",
              total_fee: "0",
              fee_currency: "USD",
            }
          : {
              id: orderId,
              status: "open",
              filled_quantity: "0",
              filled_amount: "0",
              total_fee: "0",
              fee_currency: "USD",
            },
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        placeOrder: typeof placeOrder;
      };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.04", fillCost: "4" }),
    ]);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        limit: expect.objectContaining({ quoteSize: "6" }),
      }),
    );
  });

  it("settles a terminal partial sell and relists only its remainder", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: "partial-sell",
        sellBaseSize: "0.1",
      },
    ];
    const placeOrder = vi
      .fn()
      .mockResolvedValueOnce({ data: { venue_order_id: "relisted-sell" } })
      .mockResolvedValueOnce({ data: { venue_order_id: "partial-rebuy" } });
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "partially_filled",
        filled_quantity: "0.04",
        filled_amount: "4.04",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        placeOrder: typeof placeOrder;
      };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({
        baseHeld: "0.06",
        fillCost: "6",
        sellOrderId: "relisted-sell",
      }),
    ]);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        limit: expect.objectContaining({ quoteSize: "4" }),
      }),
    );
  });

  it("keeps a partially filled order that is still active during reconciliation", async () => {
    // given
    const state = makeState();
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "partially_filled",
        filled_quantity: "0.04",
        filled_amount: "4",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const getActiveOrders = vi.fn(async () => ({
      data: [{ id: "buy-1" }],
      metadata: {},
    }));
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "unexpected-order" },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        placeOrder: typeof placeOrder;
      };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(state.levels[0].positions).toEqual([]);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("returns a remapped terminal partial fill while waiting for a market order", async () => {
    // given
    const order = {
      id: "partial-market",
      status: "partially_filled",
      filled_quantity: "0.04",
      filled_amount: "4",
      total_fee: "0",
      fee_currency: "USD",
    };
    const getOrder = vi.fn(async () => ({ data: order }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
      };
      _awaitTerminal: (
        orderId: string,
        timeoutMs: number,
      ) => Promise<typeof order>;
    };
    internals._client = { getOrder, getActiveOrders };

    // when
    const result = internals._awaitTerminal("partial-market", 10);

    // then
    await expect(result).resolves.toBe(order);
  });

  it("formats negative sell notification amounts before the currency symbol", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position = {
      id: "position-1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: "sell-1",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];
    const notify = vi.fn();
    const placeRemainingBuy = vi.fn(async () => undefined);
    const order = {
      id: "sell-1",
      status: "filled",
      filled_quantity: "0.1",
      filled_amount: "9",
      total_fee: "0",
      fee_currency: "USD",
    };
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _notify: typeof notify;
      _placeRemainingBuy: typeof placeRemainingBuy;
      _processTerminalSell: (
        level: GridState["levels"][number],
        sellLevel: GridState["levels"][number],
        currentPosition: typeof position,
        currentOrder: typeof order,
        notifyFill: boolean,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._notify = notify;
    internals._placeRemainingBuy = placeRemainingBuy;

    // when
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      order,
      true,
    );
    const message = String(notify.mock.calls[0][0]);

    // then
    expect(message).toContain("profit -$1.00");
    expect(message).toContain("total P&L: -$1.00");
    expect(message).not.toContain("$-");
  });

  it("formats negative stop-loss P&L before the currency symbol", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.config.stopLoss = "90";
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: null,
      },
    ];
    const notify = vi.fn();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: false,
      stopLoss: "90",
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, never>;
      _notify: typeof notify;
      _liquidate: (reason: string, price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {};
    internals._notify = notify;

    // when
    await internals._liquidate("stop-loss", new Decimal("80"));
    const message = String(notify.mock.calls[0][0]);

    // then
    expect(message).toContain("Realized P&L: -$2.01");
    expect(message).not.toContain("$-");
    expect(state.stats.totalFees).toBe("0.0072");
  });

  it("finishes a pending stop-loss before normal reconciliation", async () => {
    // given
    const state = makeState();
    state.halt = { reason: "stop-loss", clientOrderId: "pending-stop-loss" };
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: null,
      },
    ];
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "stop-loss-order" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "filled",
        filled_quantity: "0.1",
        filled_amount: "9",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(async () => ({
      data: [],
      metadata: {},
    }));
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        placeOrder: typeof placeOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      getOrder,
      placeOrder,
      getActiveOrders,
      getHistoricalOrders,
    };
    internals._priceSource = { peek: async () => new Decimal("90") };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "pending-stop-loss" }),
    );
    expect(state.halt).toBeUndefined();
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-1");
  });

  it("validates a trailing grid before cancelling existing orders", async () => {
    // given
    const cancelOrder = vi.fn(async () => undefined);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: true,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: { cancelOrder: typeof cancelOrder };
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = makeState();
    internals._pairInfo = { ...PAIR_INFO, quote_step: "1" };
    internals._client = { cancelOrder };

    // when
    const result = internals._rebuildGridUp(new Decimal("100.1"));

    // then
    await expect(result).rejects.toThrow(/unique prices/i);
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("counts a split level's buys by the money they hold when trailing up", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.config.splitInvestment = true;
    state.quotePrecision = "0.01";
    state.levels[0].buyOrderIds = ["full", "rebuy", "leftover"];
    state.levels[0].buyOrderQuoteSizes = {
      full: "10",
      rebuy: "6",
      leftover: "4",
    };
    state.levels[1].buyOrderIds = ["unsized"];
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: true,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;

    // when
    await internals._rebuildGridUp(new Decimal("110"));

    // then
    expect(state.levels.map((level) => level.buyOrderIds.length)).toEqual([
      2, 1, 0, 0,
    ]);
    expect(state.levels.map((level) => level.expectedBuys)).toEqual([
      2, 1, 0, 0,
    ]);
  });

  it("defers trailing while a buy placement is unresolved", async () => {
    // given
    const state = makeState();
    state.levels[0].pendingBuyClientOrderIds = ["pending-buy"];
    const cancelOrder = vi.fn(async () => undefined);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: true,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: { cancelOrder: typeof cancelOrder };
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { cancelOrder };

    // when
    await internals._rebuildGridUp(new Decimal("110"));

    // then
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(state.levels.map((level) => level.price)).toEqual([
      "99",
      "99.1",
      "99.2",
      "100",
    ]);
  });

  it("rejects a saved grid that is not aligned to current pair steps", async () => {
    // given
    const state = makeState();
    state.levels[1].price = "99.15";
    const getOrder = vi.fn(async () => {
      throw new Error("unexpected query");
    });
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder };

    // when
    const result = internals._reconcileAndInit(state);

    // then
    await expect(result).rejects.toThrow(/saved grid prices.*--reset/i);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("preserves an order when reconciliation fails transiently", async () => {
    // given
    const state = makeState();
    const getOrder = vi.fn(async () => {
      throw new Error("temporary timeout");
    });
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "unexpected-order" },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };

    // when
    const result = internals._reconcileAndInit(state);

    // then
    await expect(result).rejects.toThrow(/unable to reconcile.*timeout/i);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("advances the tick index when stop-loss ends a tick early", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.config.stopLoss = "90";
    state.levels[0].buyOrderIds = [];
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: false,
      stopLoss: "90",
    });
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, never>;
      _tickCount: number;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._client = {};

    // when
    await internals._tick(new Decimal("80"));

    // then
    expect(internals._tickCount).toBe(1);
  });

  it("still runs the stop-loss when the Telegram connections can't be read", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.config.stopLoss = "90";
    state.levels[0].buyOrderIds = [];
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: false,
      stopLoss: "90",
    });
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, never>;
      _persistState: boolean;
      _warnings: string[];
      _liquidate: (reason: string, price?: Decimal) => Promise<void>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._client = {};
    internals._persistState = true;
    const liquidate = vi.fn(async () => undefined);
    internals._liquidate = liquidate;
    vi.mocked(loadConnections).mockImplementationOnce(() => {
      throw new Error("telegram.json can't be read (EACCES).");
    });

    // when
    await internals._tick(new Decimal("80"));

    // then
    expect(liquidate).toHaveBeenCalledWith("stop-loss", new Decimal("80"));
    expect(internals._warnings).toContainEqual(
      expect.stringContaining("Telegram connections can't be read"),
    );
  });

  it("ends the grid on shutdown while acquired base remains", async () => {
    // given
    vi.mocked(saveGridState).mockClear();
    vi.mocked(deleteGridState).mockClear();
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: "sell-1",
        sellBaseSize: "0.1",
        sellClientOrderId: "sell-client-1",
      },
    ];
    const cancelOrder = vi.fn(async () => undefined);
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "cancelled",
        filled_quantity: "0",
        filled_amount: "0",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _client: { cancelOrder: typeof cancelOrder; getOrder: typeof getOrder };
    };
    internals._state = state;
    internals._client = { cancelOrder, getOrder };

    // when
    await bot.shutdown();

    // then
    expect(cancelOrder).toHaveBeenCalledWith("sell-1");
    expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
  });

  it("cancel-checks a split buy in flight before it ends the grid", async () => {
    // given
    vi.mocked(saveGridState).mockClear();
    vi.mocked(deleteGridState).mockClear();
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.initializing = true;
    state.splitClientOrderId = "split-client-1";
    state.splitOrderId = "split-order-1";
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const checked: string[] = [];
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, never>;
      _cancelUntilClosed: (orderId: string) => Promise<{
        closed: boolean;
        order: OrderDetails | null;
      }>;
    };
    internals._state = state;
    internals._client = {};
    internals._cancelUntilClosed = async (orderId: string) => {
      checked.push(orderId);
      return {
        closed: true,
        order: {
          id: orderId,
          side: "buy",
          status: "filled",
          filled_quantity: "0.1",
        } as OrderDetails,
      };
    };

    // when
    await bot.shutdown();

    // then
    expect(checked).toEqual(["split-order-1"]);
    expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
  });
});

describe("grid bot take-now crossings", () => {
  type Request = {
    clientOrderId: string;
    side: "buy" | "sell";
    limit?: {
      price: string;
      quoteSize?: string;
      baseSize?: string;
      executionInstructions?: string[];
    };
  };

  it("sells crossed levels at once and re-buys each original level with the full amount on the next check", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = ["buy-0"];
    state.levels[1].buyOrderIds = ["buy-1"];
    state.levels[2].buyOrderIds = ["buy-2"];
    for (const level of state.levels.slice(0, 3)) {
      level.buyOrderQuoteSizes = { [`buy-${level.index}`]: "10" };
    }
    const orders = new Map<string, Partial<OrderDetails>>([
      [
        "buy-0",
        { status: "filled", filled_quantity: "0.101", filled_amount: "9.99" },
      ],
      [
        "buy-1",
        { status: "filled", filled_quantity: "0.1", filled_amount: "9.91" },
      ],
      [
        "buy-2",
        { status: "filled", filled_quantity: "0.1", filled_amount: "9.92" },
      ],
    ]);
    const placeOrder = vi.fn(async (request: Request) => {
      const id = `${request.side}-${request.limit?.price}`;
      if (request.side === "sell") {
        const quantity = request.limit!.baseSize!;
        const gross = new Decimal(quantity).times("101");
        const fee = gross.times("0.0009").toDecimalPlaces(2, Decimal.ROUND_UP);
        orders.set(id, {
          status: "filled",
          filled_quantity: quantity,
          filled_amount: gross.toString(),
          average_fill_price: "101",
          total_fee: fee.toString(),
          fee_currency: "USD",
        });
      }
      return {
        data: {
          venue_order_id: id,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    const getOrder = vi.fn(async (id: string) => ({
      data: { id, ...orders.get(id) } as OrderDetails,
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder, getOrder, getActiveOrders, getBalances };

    const placed = () =>
      placeOrder.mock.calls.map(([request]) => [
        request.side,
        request.limit?.price,
        request.side === "sell"
          ? request.limit?.baseSize
          : request.limit?.quoteSize,
        request.limit?.executionInstructions,
      ]);

    // when
    await internals._tick(new Decimal("101"));
    const firstCheck = placed();
    await internals._tick(new Decimal("101"));

    // then
    expect(firstCheck).toEqual([
      ["sell", "99.1", "0.101", ["allow_taker"]],
      ["sell", "99.2", "0.1", ["allow_taker"]],
      ["sell", "100", "0.1", ["allow_taker"]],
    ]);
    expect(placed().slice(3)).toEqual([
      ["buy", "99", "10", ["allow_taker"]],
      ["buy", "99.1", "10", ["allow_taker"]],
      ["buy", "99.2", "10", ["allow_taker"]],
    ]);
    expect(state.stats.realizedPnl).toBe("0.551");
    expect(state.stats.totalFees).toBe("0.03");
    expect(
      state.tradeLog
        .filter((entry) => entry.side === "sell")
        .map((e) => e.price),
    ).toEqual(["101", "101", "101"]);
  });
});

describe("grid bot opposite-order amounts", () => {
  function amountsBot(state: GridState) {
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const placeBuyOrder = vi.fn(async () => "rebuy");
    const placeSellOnLevel = vi.fn(async () => undefined);
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _placeBuyOrder: typeof placeBuyOrder;
      _placeSellOnLevel: typeof placeSellOnLevel;
      _processTerminalBuy: (
        level: GridLevelState,
        order: OrderDetails,
        notify: boolean,
      ) => Promise<boolean>;
      _processTerminalSell: (
        level: GridLevelState,
        sellLevel: GridLevelState,
        position: GridLevelPosition,
        order: OrderDetails,
        notify: boolean,
      ) => Promise<unknown>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._placeBuyOrder = placeBuyOrder;
    internals._placeSellOnLevel = placeSellOnLevel;
    return { internals, placeBuyOrder };
  }

  function fill(overrides: Partial<OrderDetails>): OrderDetails {
    return {
      id: "order",
      status: "filled",
      filled_quantity: "0",
      total_fee: "0",
      fee_currency: "USD",
      ...overrides,
    } as OrderDetails;
  }

  it("re-buys exactly the slot amount across a partial sale and its remainder", async () => {
    // given
    const state = makeState();
    state.quotePrecision = "0.1";
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.101",
      fillCost: "9.9",
      slotQuote: "10",
      sellOrderId: "sell-1",
      sellBaseSize: "0.101",
    };
    state.levels[0].positions = [position];
    const { internals, placeBuyOrder } = amountsBot(state);

    // when
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({
        id: "sell-1",
        status: "cancelled",
        filled_quantity: "0.05",
        filled_amount: "4.96",
      }),
      false,
    );
    position.sellOrderId = "sell-2";
    position.sellBaseSize = "0.051";
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({ id: "sell-2", filled_quantity: "0.051", filled_amount: "5.06" }),
      false,
    );

    // then
    const amounts = placeBuyOrder.mock.calls.map(([, quote]) => String(quote));
    expect(amounts).toEqual(["4.9", "5.1"]);
    expect(state.levels[0].positions).toEqual([]);
  });

  it("keeps a partial re-buy's share in the slot when that re-buy is too small to place", async () => {
    // given
    const state = makeState();
    state.quotePrecision = "0.1";
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "10",
      slotQuote: "10",
      sellOrderId: "sell-1",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];
    const { internals, placeBuyOrder } = amountsBot(state);

    // when
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({
        id: "sell-1",
        status: "cancelled",
        filled_quantity: "0.005",
        filled_amount: "0.5",
      }),
      false,
    );
    position.sellOrderId = "sell-2";
    position.sellBaseSize = "0.095";
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({ id: "sell-2", filled_quantity: "0.095", filled_amount: "9.5" }),
      false,
    );

    // then
    const amounts = placeBuyOrder.mock.calls.map(([, quote]) => String(quote));
    expect(amounts).toEqual(["10"]);
  });

  it("treats a position from an older save file as holding the full per-level slot", async () => {
    // given
    const state = makeState();
    state.quotePrecision = "0.1";
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "legacy",
      baseHeld: "0.101",
      fillCost: "9.9",
      sellOrderId: "sell-1",
      sellBaseSize: "0.101",
    };
    state.levels[0].positions = [position];
    const { internals, placeBuyOrder } = amountsBot(state);

    // when
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({
        id: "sell-1",
        status: "cancelled",
        filled_quantity: "0.05",
        filled_amount: "4.96",
      }),
      false,
    );
    position.sellOrderId = "sell-2";
    position.sellBaseSize = "0.051";
    await internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      fill({ id: "sell-2", filled_quantity: "0.051", filled_amount: "5.06" }),
      false,
    );

    // then
    const amounts = placeBuyOrder.mock.calls.map(([, quote]) => String(quote));
    expect(amounts).toEqual(["4.9", "5.1"]);
  });

  it("gives a partly filled buy only its share of the slot when the rest goes back on the book", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const { internals, placeBuyOrder } = amountsBot(state);

    // when
    await internals._processTerminalBuy(
      state.levels[0],
      fill({
        id: "buy-1",
        status: "cancelled",
        filled_quantity: "0.06",
        filled_amount: "6",
      }),
      false,
    );

    // then
    expect(placeBuyOrder).toHaveBeenCalledWith(
      state.levels[0],
      new Decimal("4"),
    );
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.06", slotQuote: "6" }),
    ]);
  });
});

describe("grid bot take-now recovery", () => {
  it("refills empty buy levels the price has already passed", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const placeOrder = vi.fn(
      async (request: { clientOrderId: string; limit: { price: string } }) => ({
        data: {
          venue_order_id: `buy-${request.limit.price}`,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      }),
    );
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getActiveOrders: vi.fn(async () => ({ data: [], metadata: {} })),
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };

    // when
    await internals._tick(new Decimal("98"));

    // then
    expect(
      placeOrder.mock.calls.map(([request]) => request.limit.price),
    ).toEqual(["99", "99.1", "99.2"]);
  });

  it("re-places a cancelled smaller buy at its own size, not the full slot", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = ["remainder-buy"];
    state.levels[0].buyOrderQuoteSizes = { "remainder-buy": "4" };
    state.levels[0].positions = [
      {
        id: "p1",
        baseHeld: "0.06",
        fillCost: "6",
        slotQuote: "6",
        sellOrderId: "sell-1",
        sellBaseSize: "0.06",
      },
    ];
    const placeOrder = vi.fn(
      async (request: {
        clientOrderId: string;
        limit: { price: string; quoteSize?: string };
      }) => ({
        data: {
          venue_order_id: "replacement",
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      }),
    );
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder: vi.fn(async (id: string) => ({
        data: {
          id,
          status: id === "sell-1" ? "new" : "cancelled",
          filled_quantity: "0",
        } as OrderDetails,
      })),
      getActiveOrders: vi.fn(async () => ({
        data: [{ id: "sell-1" }],
        metadata: {},
      })),
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    const level0 = placeOrder.mock.calls
      .map(([request]) => request)
      .filter((request) => request.limit.price === "99");
    expect(level0.map((request) => request.limit.quoteSize)).toEqual(["4"]);
  });

  it("keeps a crossing sell that only partly filled instead of selling the rest twice", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const orders = new Map<string, Partial<OrderDetails>>([
      [
        "buy-1",
        { status: "filled", filled_quantity: "0.101", filled_amount: "9.99" },
      ],
    ]);
    const placeOrder = vi.fn(
      async (request: {
        clientOrderId: string;
        side: string;
        limit: { price: string; baseSize?: string };
      }) => {
        const id = `${request.side}-${request.limit.price}`;
        if (request.side === "sell") {
          orders.set(id, {
            status: "partially_filled",
            filled_quantity: "0.05",
            filled_amount: "5.05",
          });
        }
        return {
          data: {
            venue_order_id: id,
            client_order_id: request.clientOrderId,
            state: "new" as const,
          },
        };
      },
    );
    let activeCalls = 0;
    const getActiveOrders = vi.fn(async () => {
      activeCalls++;
      return {
        data: activeCalls === 1 ? [] : [{ id: "sell-99.1" }],
        metadata: {},
      };
    });
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder: vi.fn(async (id: string) => ({
        data: { id, ...orders.get(id) } as OrderDetails,
      })),
      getActiveOrders,
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };

    // when
    await internals._tick(new Decimal("101"));

    // then
    const requests = placeOrder.mock.calls.map(([request]) => request);
    expect(requests.filter((request) => request.side === "sell")).toHaveLength(
      1,
    );
    expect(
      requests.filter(
        (request) => request.side === "buy" && request.limit.price === "99",
      ),
    ).toEqual([]);
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.101", sellOrderId: "sell-99.1" }),
    ]);
  });
});

describe("grid bot refused re-sends while running", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function listed(overrides: Partial<Order>): Order {
    return {
      id: "listed",
      client_order_id: "stale",
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      quantity: "0.1",
      filled_quantity: "0",
      leaves_quantity: "0.1",
      price: "99",
      status: "new",
      time_in_force: "gtc",
      execution_instructions: ["allow_taker"],
      created_date: 1,
      updated_date: 1,
      ...overrides,
    };
  }

  function refusingBot(exchange: { active?: Order[]; historical?: Order[] }) {
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.levels[0].buyOrderIds = [];
    const placeOrder = vi.fn(async (request: { clientOrderId: string }) => {
      throw new BadRequestError(
        `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
      );
    });
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _attentionLines: () => string[];
      _client: Record<string, unknown>;
      _pendingSweepAt: number;
      _sweepPendingIntents: (activeOrders: Map<string, Order>) => Promise<void>;
      _placeBuyOrAlert: (
        level: GridLevelState,
        quote?: Decimal,
      ) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getActiveOrders: vi.fn(async () => ({
        data: exchange.active ?? [],
        metadata: {},
      })),
      getHistoricalOrders: vi.fn(
        async (request: { startDate: number; endDate: number }) => ({
          data:
            request.startDate <= request.endDate
              ? (exchange.historical ?? [])
              : [],
          metadata: {},
        }),
      ),
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };
    return { state, internals, placeOrder };
  }

  it("adopts the live buy found for a stuck id", async () => {
    // given
    const { state, internals } = refusingBot({
      active: [listed({ id: "live-buy" })],
    });
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };

    // when
    await internals._sweepPendingIntents(new Map());

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["live-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("replaces a stuck buy that the exchange had rejected with a fresh one once 5 minutes have passed", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = refusingBot({
      historical: [listed({ id: "old", status: "rejected" })],
    });
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };
    placeOrder.mockImplementation(
      async (request: { clientOrderId: string }) =>
        ({
          data: {
            venue_order_id: "fresh-buy",
            client_order_id: request.clientOrderId,
            state: "new" as const,
          },
        }) as never,
    );

    await internals._sweepPendingIntents(new Map());
    const withinFiveMinutes = placeOrder.mock.calls.length;

    // when
    vi.setSystemTime(Date.now() + 5 * 60_000);
    internals._pendingSweepAt = 0;
    await internals._sweepPendingIntents(new Map());

    // then
    expect(withinFiveMinutes).toBe(0);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).not.toBe("stale");
    expect(state.levels[0].buyOrderIds).toEqual(["fresh-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(internals._warnings).toEqual(["Buy @99 rejected, retrying (2/3)"]);
  });

  it("stops re-sending a refused id it can't find and only looks it up again later", async () => {
    // given
    const { state, internals, placeOrder } = refusingBot({});
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };

    // when
    for (let sweep = 0; sweep < 3; sweep++) {
      internals._pendingSweepAt = 0;
      await internals._sweepPendingIntents(new Map());
    }

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale"]);
    expect(internals._attentionLines()).toEqual([
      "Buy @99 rejected or already placed, looked up once a minute",
    ]);
  });

  it("replaces a dead buy with a fresh id even while another id is stuck", async () => {
    // given
    const { state, internals, placeOrder } = refusingBot({});
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };
    placeOrder.mockImplementation(
      async (request: { clientOrderId: string }) => ({
        data: {
          venue_order_id: "fresh-buy",
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      }),
    );

    // when
    await internals._placeBuyOrAlert(state.levels[0], new Decimal("10"));

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).not.toBe("stale");
    expect(state.levels[0].buyOrderIds).toEqual(["fresh-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale"]);
  });

  it("adopts the live sell the lookup finds when a stuck sell is refused as already placed", async () => {
    // given
    const { state, internals } = refusingBot({
      active: [
        listed({
          id: "live-sell",
          client_order_id: "stale-sell",
          side: "sell",
        }),
      ],
    });
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
      sellClientOrderId: "stale-sell",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    await internals._sweepPendingIntents(new Map());

    // then
    expect(position.sellOrderId).toBe("live-sell");
  });
});

describe("grid bot unconfirmed buys while running", () => {
  type PlaceRequest = {
    clientOrderId: string;
    limit: { price: string; quoteSize?: string };
  };

  function listedBuy(clientOrderId: string, id: string): Order {
    return {
      id,
      client_order_id: clientOrderId,
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      quantity: "0.04",
      filled_quantity: "0",
      leaves_quantity: "0.04",
      price: "99",
      status: "new",
      time_in_force: "gtc",
      execution_instructions: ["allow_taker"],
      created_date: 1,
      updated_date: 1,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function aMinuteLater() {
    vi.setSystemTime(Date.now() + 61_000);
  }

  function leftoverBot(
    options: {
      active?: Order[];
      historical?: Order[];
      available?: string;
    } = {},
  ) {
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "p1",
        baseHeld: "0.06",
        fillCost: "6",
        slotQuote: "6",
        sellOrderId: "sell-1",
        sellBaseSize: "0.06",
      },
    ];
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "4" };
    const exchange = {
      active: options.active ?? [],
      available: options.available ?? "1000",
    };
    const placeOrder = vi.fn(async (request: PlaceRequest) => ({
      data: {
        venue_order_id: `placed-${request.clientOrderId}`,
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    }));
    const getHistoricalOrders = vi.fn(
      async (request: { startDate: number; endDate: number }) => ({
        data:
          request.startDate <= request.endDate
            ? (options.historical ?? [])
            : [],
        metadata: {},
      }),
    );
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder: vi.fn(async (id: string) => ({
        data: { id, status: "new", filled_quantity: "0" } as OrderDetails,
      })),
      getActiveOrders: vi.fn(async () => ({
        data: [listedBuy("sell-1-client", "sell-1"), ...exchange.active],
        metadata: {},
      })),
      getHistoricalOrders,
      getBalances: vi.fn(async () => [
        { currency: "USD", available: exchange.available },
      ]),
    };
    const sentFor = (price: string) =>
      placeOrder.mock.calls
        .map(([request]) => request)
        .filter((request) => request.limit.price === price);
    return {
      state,
      internals,
      exchange,
      placeOrder,
      getHistoricalOrders,
      sentFor,
    };
  }

  it("tracks a leftover buy whose reply was lost, on a level that holds coins", async () => {
    // given
    const { state, internals, sentFor } = leftoverBot({
      active: [listedBuy("lost", "live-4")],
    });

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["live-4"]);
    expect(state.levels[0].buyOrderQuoteSizes?.["live-4"]).toBe("4");
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(sentFor("99")).toEqual([]);
  });

  it("re-sends a leftover buy missing from two lookups, with the same id and amount", async () => {
    // given
    const { state, internals, sentFor } = leftoverBot();

    // when
    await internals._tick(new Decimal("99.5"));
    const afterFirstLookup = sentFor("99").length;
    aMinuteLater();
    await internals._tick(new Decimal("99.5"));

    // then
    expect(afterFirstLookup).toBe(0);
    expect(
      sentFor("99").map((request) => [
        request.clientOrderId,
        request.limit.quoteSize,
      ]),
    ).toEqual([["lost", "4"]]);
    expect(state.levels[0].buyOrderIds).toEqual(["placed-lost"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("waits while the cash is short and re-sends once it is back", async () => {
    // given
    const { state, internals, exchange, sentFor } = leftoverBot({
      available: "3",
    });

    // when
    await internals._tick(new Decimal("99.5"));
    aMinuteLater();
    await internals._tick(new Decimal("99.5"));
    const whileShort = sentFor("99").length;
    exchange.available = "1000";
    aMinuteLater();
    await internals._tick(new Decimal("99.5"));

    // then
    expect(whileShort).toBe(0);
    expect(sentFor("99").map((request) => request.clientOrderId)).toEqual([
      "lost",
    ]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("re-places a leftover buy that turned out cancelled, at its own amount", async () => {
    // given
    const { state, internals, sentFor } = leftoverBot({
      historical: [
        { ...listedBuy("lost", "dead-4"), status: "cancelled" } as Order,
      ],
    });

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    const sent = sentFor("99");
    expect(sent.map((request) => request.limit.quoteSize)).toEqual(["4"]);
    expect(sent[0].clientOrderId).not.toBe("lost");
    expect(state.levels[0].buyOrderIds).toEqual([
      `placed-${sent[0].clientOrderId}`,
    ]);
    expect(state.levels[0].positions[0].slotQuote).toBe("6");
  });

  it("looks unconfirmed buys up at most once a minute", async () => {
    // given
    const { internals, getHistoricalOrders } = leftoverBot({
      available: "3",
    });

    // when
    await internals._tick(new Decimal("99.5"));
    await internals._tick(new Decimal("99.5"));

    // then
    expect(getHistoricalOrders).toHaveBeenCalledTimes(1);
  });

  it("sends each unconfirmed buy once per check, even two on one empty level", async () => {
    // given
    const { state, internals, placeOrder, sentFor } = leftoverBot();
    state.levels[0].pendingBuyClientOrderIds = [];
    state.levels[1].expectedBuys = 2;
    state.levels[1].pendingBuyClientOrderIds = ["first", "second"];
    state.levels[1].pendingBuyQuoteSizes = { first: "10", second: "10" };
    placeOrder.mockImplementation(async () => {
      throw new Error("socket hang up");
    });

    // when
    await internals._tick(new Decimal("99.5"));
    aMinuteLater();
    await internals._tick(new Decimal("99.5"));

    // then
    expect(
      sentFor("99.1")
        .map((request) => request.clientOrderId)
        .sort(),
    ).toEqual(["first", "second"]);
  });
});

describe("grid bot leftover buy amounts", () => {
  function partialBuyBot(placeOrder: ReturnType<typeof vi.fn>) {
    const state = makeState();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const notify = vi.fn();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _notify: typeof notify;
      _processTerminalBuy: (
        level: GridLevelState,
        order: OrderDetails,
        notify: boolean,
      ) => Promise<boolean>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder };
    internals._notify = notify;
    return { state, internals, notify };
  }

  function partialFill(filledQuantity: string, filledAmount: string) {
    return {
      id: "buy-1",
      status: "cancelled",
      filled_quantity: filledQuantity,
      filled_amount: filledAmount,
      total_fee: "0",
      fee_currency: "USD",
    } as OrderDetails;
  }

  it("takes the leftover out of its slot as soon as the buy is recorded, even if the reply is lost", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockResolvedValueOnce({
        data: { venue_order_id: "sell-1", state: "new" },
      })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const { state, internals } = partialBuyBot(placeOrder);

    // when
    await internals._processTerminalBuy(
      state.levels[0],
      partialFill("0.06", "6"),
      false,
    );

    // then
    expect(state.levels[0].positions[0].slotQuote).toBe("6");
    expect(Object.values(state.levels[0].pendingBuyQuoteSizes ?? {})).toEqual([
      "4",
    ]);
  });

  it("keeps a leftover too small to place in its slot, without an alert", async () => {
    // given
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "sell-1", state: "new" },
    }));
    const { state, internals, notify } = partialBuyBot(placeOrder);

    // when
    await internals._processTerminalBuy(
      state.levels[0],
      partialFill("0.091", "9"),
      false,
    );

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].positions[0].slotQuote).toBe("10");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("grid bot leftover buys that leave the book unfilled", () => {
  function leftoverLevel(state: GridState): GridLevelPosition {
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.06",
      fillCost: "6",
      slotQuote: "6",
      sellOrderId: "sell-1",
      sellBaseSize: "0.06",
    };
    state.levels[0].positions = [position];
    state.levels[0].buyOrderIds = ["rest-4"];
    state.levels[0].buyOrderQuoteSizes = { "rest-4": "4" };
    return position;
  }

  function newBot() {
    return new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
  }

  it("gives a leftover cancelled on Ctrl+C back to its position's budget", async () => {
    // given
    const state = makeState();
    const position = leftoverLevel(state);
    const internals = newBot() as unknown as {
      _state: GridState;
      _cancelUntilClosed: (orderId: string) => Promise<unknown>;
      _closeGridOrders: (
        state: GridState,
        policy: "settle" | "keepTraded",
      ) => Promise<unknown>;
    };
    internals._state = state;
    internals._cancelUntilClosed = async (orderId: string) => ({
      closed: true,
      order: { id: orderId, status: "cancelled", filled_quantity: "0" },
    });

    // when
    await internals._closeGridOrders(state, "keepTraded");

    // then
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(position.slotQuote).toBe("10");
  });

  it("gives a leftover found cancelled at start-up back to its position's budget", async () => {
    // given
    const state = makeState();
    const position = leftoverLevel(state);
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: orderId === "sell-1" ? "new" : "cancelled",
        filled_quantity: "0",
      },
    }));
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "unexpected" },
    }));
    const internals = newBot() as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].buyOrderIds).not.toContain("rest-4");
    expect(position.slotQuote).toBe("10");
  });
});

describe("grid bot damaged save file", () => {
  function startupBot(reset: boolean) {
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset,
      trailingUp: false,
    });
    return bot as unknown as { _loadSavedGrid: () => GridState | null };
  }

  it("refuses to start a new grid over a damaged save file", () => {
    // given
    vi.mocked(loadGridState).mockImplementationOnce(() => {
      throw new GridStateDamagedError(
        "/config/grid_state_BTC-USD.json",
        "Unexpected end of JSON input",
      );
    });
    vi.mocked(setAsideGridState).mockClear();

    // when
    let failure: unknown;
    try {
      startupBot(false)._loadSavedGrid();
    } catch (err) {
      failure = err;
    }

    // then
    expect(String(failure)).toMatch(/cancel the old grid's open orders/);
    expect(String(failure)).toMatch(/--reset/);
    expect(setAsideGridState).not.toHaveBeenCalled();
  });

  it("sets the damaged file aside and starts fresh with --reset", () => {
    // given
    vi.mocked(loadGridState).mockImplementationOnce(() => {
      throw new GridStateDamagedError(
        "/config/grid_state_BTC-USD.json",
        "Unexpected end of JSON input",
      );
    });
    vi.mocked(setAsideGridState).mockClear();

    // when
    const state = startupBot(true)._loadSavedGrid();

    // then
    expect(state).toBeNull();
    expect(setAsideGridState).toHaveBeenCalledWith("BTC-USD");
  });
});

describe("grid bot placement failure alerts", () => {
  function alertingBot(placeOrder: ReturnType<typeof vi.fn>) {
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const notify = vi.fn();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _client: { placeOrder: typeof placeOrder };
      _notify: typeof notify;
      _flushPlacementAlerts: () => void;
      _attentionLines: () => string[];
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
      _placeBuyOrAlert: (level: GridLevelState) => Promise<string | null>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder };
    internals._notify = notify;
    return { state, internals, notify };
  }

  function accepted(request: { clientOrderId: string }) {
    return {
      data: {
        venue_order_id: "placed",
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    };
  }

  it("notifies once when a sell can't be placed, and again only after it worked in between", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("Insufficient balance"))
      .mockRejectedValueOnce(new Error("Insufficient balance"))
      .mockImplementationOnce(async (request) => accepted(request))
      .mockRejectedValueOnce(new Error("Insufficient balance"));
    const { state, internals, notify } = alertingBot(placeOrder);
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
    };
    state.levels[0].positions = [position];

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();
    const afterTwoFailures = notify.mock.calls.length;
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();
    position.sellOrderId = null;
    position.sellClientOrderId = undefined;
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();

    // then
    expect(afterTwoFailures).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(String(notify.mock.calls[0][0])).toContain(
      "could not place the sell of 0.1 BTC at $99.1 (Insufficient balance). The bot keeps retrying.",
    );
    expect(internals._attentionLines()).toEqual([
      "Sell @99.1 not placed: Insufficient balance",
    ]);
  });

  it("names why the automatic retry after a server error failed", async () => {
    // given
    const placeOrder = vi.fn().mockRejectedValue(
      new ServerError("Service unavailable", 503, {
        cause: new BadRequestError("Insufficient balance"),
      }),
    );
    const { state, internals, notify } = alertingBot(placeOrder);
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
    };
    state.levels[0].positions = [position];

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();

    // then
    expect(String(notify.mock.calls[0][0])).toContain(
      "(Service unavailable. The automatic retry then failed: Insufficient balance). The bot keeps retrying.",
    );
  });

  it("notifies again for a buy only after one was placed in between", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("Insufficient balance"))
      .mockImplementationOnce(async (request) => accepted(request))
      .mockRejectedValueOnce(new Error("Insufficient balance"));
    const { state, internals, notify } = alertingBot(placeOrder);

    // when
    await internals._placeBuyOrAlert(state.levels[0]);
    internals._flushPlacementAlerts();
    await internals._placeBuyOrAlert(state.levels[0]);
    internals._flushPlacementAlerts();
    state.levels[0].buyOrderIds = [];
    await internals._placeBuyOrAlert(state.levels[0]);
    internals._flushPlacementAlerts();

    // then
    expect(notify).toHaveBeenCalledTimes(2);
    expect(String(notify.mock.calls[0][0])).toContain(
      "could not place the buy of $10.00 at $99 (Insufficient balance). The bot keeps retrying.",
    );
  });

  it("notifies once when a buy can't be placed", async () => {
    // given
    const placeOrder = vi.fn(async () => {
      throw new Error("Insufficient balance");
    });
    const { state, internals, notify } = alertingBot(placeOrder);

    // when
    await internals._placeBuyOrAlert(state.levels[0]);
    internals._flushPlacementAlerts();
    await internals._placeBuyOrAlert(state.levels[0]);
    internals._flushPlacementAlerts();

    // then
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain(
      "could not place the buy of $10.00 at $99",
    );
  });
});

describe("grid bot dry-run buy cost", () => {
  it("charges a dry-run buy what its coins cost at the level price", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.basePrecision = "0.01";
    state.quotePrecision = "0.01";
    state.levels[0].price = "99.05";
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: true,
        reset: false,
        trailingUp: false,
      },
      { suppressDashboard: true },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;

    // when
    await internals._tick(new Decimal("98.9"));

    // then
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.1", fillCost: "9.91" }),
    ]);
  });

  it("credits a dry-run sale what the exchange would pay, rounded down to the price step", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.quotePrecision = "0.01";
    state.levels[0].buyOrderIds = [];
    state.levels[1].price = "99.15";
    state.levels[0].positions = [
      {
        id: "p1",
        baseHeld: "0.101",
        fillCost: "10",
        sellOrderId: "dry-sell-1",
        sellBaseSize: "0.101",
      },
    ];
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: true,
        reset: false,
        trailingUp: false,
      },
      { suppressDashboard: true },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;

    // when
    await internals._tick(new Decimal("99.2"));

    // then
    expect(state.stats.realizedPnl).toBe("0.01");
  });
});

describe("grid bot attention lines and end-of-check alerts", () => {
  type Request = { clientOrderId: string; side: "buy" | "sell" };

  function attentionBot(
    options: {
      placeOrder?: ReturnType<typeof vi.fn>;
      available?: () => string;
      historical?: Order[];
      dryRun?: boolean;
    } = {},
  ) {
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.config.dryRun = options.dryRun ?? false;
    const placeOrder =
      options.placeOrder ??
      vi.fn(async () => {
        throw new Error("Insufficient balance");
      });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(
      async (request: { startDate: number; endDate: number }) => ({
        data:
          request.startDate <= request.endDate
            ? (options.historical ?? [])
            : [],
        metadata: {},
      }),
    );
    const getOrder = vi.fn(async (id: string) => ({
      data: {
        id,
        client_order_id: id,
        status: "cancelled",
        filled_quantity: "0",
      } as OrderDetails,
    }));
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: options.available?.() ?? "1000" },
    ]);
    const cancelOrder = vi.fn(async () => undefined);
    const notify = vi.fn(async () => true);
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: options.dryRun ?? false,
        reset: false,
        trailingUp: false,
      },
      { suppressDashboard: true },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _running: boolean;
      _warnings: string[];
      _client: Record<string, unknown>;
      _notify: typeof notify;
      _priceSource: {
        peek: () => Promise<Decimal>;
        next?: () => Promise<{ price: Decimal; timestamp: number } | null>;
      };
      _flushPlacementAlerts: () => void;
      _attentionLines: () => string[];
      _tick: (price: Decimal) => Promise<void>;
      _loop: () => Promise<void>;
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
      _rebuildGridUp: (price: Decimal) => Promise<void>;
      _placeBuyOrAlert: (level: GridLevelState) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      cancelOrder,
      getActiveOrders,
      getHistoricalOrders,
      getOrder,
      getBalances,
    };
    internals._notify = notify;
    internals._priceSource = { peek: async () => new Decimal("100") };
    return { bot, state, internals, notify, placeOrder };
  }

  function heldPosition(): GridLevelPosition {
    return { id: "p1", baseHeld: "0.1", fillCost: "10", sellOrderId: null };
  }

  function accepted(request: Request) {
    return {
      data: {
        venue_order_id: `placed-${request.clientOrderId}`,
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    };
  }

  function runChecks(
    internals: ReturnType<typeof attentionBot>["internals"],
    checks: number,
  ) {
    const prices = Array.from({ length: checks }, () => new Decimal("100"));
    internals._running = true;
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () => {
        const price = prices.shift();
        return price ? { price, timestamp: 1 } : null;
      },
    };
    return internals._loop();
  }

  it("shows a lasting line for a grid order cancelled outside the bot", async () => {
    // given
    const placeOrder = vi.fn(async (request: Request) => accepted(request));
    const { state, internals } = attentionBot({ placeOrder });
    state.levels[0].buyOrderIds = ["buy-x"];
    state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };
    internals._client.getOrder = vi.fn(async (id: string) => ({
      data: {
        id,
        client_order_id: id,
        status: id === "buy-x" ? "cancelled" : "new",
        filled_quantity: "0",
      } as OrderDetails,
    }));

    // when
    await runChecks(internals, 2);

    // then
    expect(internals._attentionLines()).toContainEqual(
      expect.stringMatching(
        /^1 order cancelled outside the bot, placed again \(last \d\d:\d\d:\d\d\)$/,
      ),
    );
  });

  it("doesn't count an order the bot cancelled itself", async () => {
    // given
    const placeOrder = vi.fn(async (request: Request) => accepted(request));
    const { state, internals } = attentionBot({ placeOrder });
    state.levels[0].buyOrderIds = ["buy-x"];
    state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };
    internals._client.getOrder = vi.fn(async (id: string) => ({
      data: {
        id,
        client_order_id: id,
        status: id === "buy-x" ? "cancelled" : "new",
        filled_quantity: "0",
      } as OrderDetails,
    }));
    await (
      internals as unknown as {
        _cancelUntilClosed: (orderId: string) => Promise<unknown>;
      }
    )._cancelUntilClosed("buy-x");

    // when
    await runChecks(internals, 1);

    // then
    expect(
      internals._attentionLines().some((line) => line.includes("outside")),
    ).toBe(false);
  });

  it.each([
    ["a replaced status", { status: "replaced" }],
    [
      "a cancel the exchange made for a replace",
      { status: "cancelled", reject_reason: "replaced" },
    ],
    [
      "a replace after a partial fill",
      {
        status: "partially_filled",
        reject_reason: "replaced",
        filled_quantity: "0.05",
        filled_amount: "4.95",
        average_fill_price: "99",
        total_fee: "0",
        fee_currency: "BTC",
      },
    ],
  ] as const)(
    "says a replacement made outside the bot is not tracked, from %s",
    async (_, closed) => {
      // given
      const placeOrder = vi.fn(async (request: Request) => accepted(request));
      const { state, internals } = attentionBot({ placeOrder });
      state.levels[0].buyOrderIds = ["buy-x"];
      state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };
      internals._client.getOrder = vi.fn(async (id: string) => ({
        data: {
          id,
          client_order_id: id,
          status: "new",
          filled_quantity: "0",
          ...(id === "buy-x" ? closed : {}),
        } as OrderDetails,
      }));

      // when
      await runChecks(internals, 1);

      // then
      expect(internals._attentionLines()).toContain(
        "1 order replaced outside the bot, placed again, replacement untracked",
      );
      expect(
        internals._attentionLines().some((line) => line.includes("cancelled")),
      ).toBe(false);
      expect(placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ side: "buy" }),
      );
    },
  );

  it("alerts a refused key at once and again when the key works", async () => {
    // given
    const { internals, notify } = attentionBot();
    (internals as unknown as { _keyLabel: string | null })._keyLabel =
      "u8jz****mxgJ";
    const refusal = new AuthenticationError("Unable to resolve API key");
    let refused = 2;
    const listOrders = internals._client.getActiveOrders as (
      ...args: unknown[]
    ) => Promise<unknown>;
    internals._client.getActiveOrders = vi.fn(async (...args: unknown[]) => {
      if (refused-- > 0) throw refusal;
      return listOrders(...args);
    });
    internals._running = true;
    let ticks = 3;
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () =>
        ticks-- > 0
          ? { price: new Decimal("100"), timestamp: Date.now() }
          : null,
    };

    // when
    await internals._loop();

    // then
    const messages = notify.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Revolut X"));
    expect(messages).toEqual([
      "Grid Bot BTC-USD: Revolut X refused the API key u8jz****mxgJ with 401 Unable to resolve API key. Check the API key and the private key with revx configure, then start the grid again. Open grid orders stay on the exchange meanwhile.",
      "Grid Bot BTC-USD: Revolut X accepts the API key again.",
    ]);
  });

  it("sends a lost key alert again a minute later", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { internals, notify } = attentionBot();
    notify.mockResolvedValueOnce(false);
    internals._client.getActiveOrders = vi.fn(async () => {
      throw new ForbiddenError("Forbidden");
    });
    internals._running = true;
    const gaps = [0, 30_000, 31_000, 30_000];
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () => {
        const gap = gaps.shift();
        if (gap === undefined) return null;
        vi.setSystemTime(Date.now() + gap);
        return { price: new Decimal("100"), timestamp: Date.now() };
      },
    };

    // when
    await internals._loop();

    // then
    const messages = notify.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("refused the API key"));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("with 403 Forbidden.");
    expect(messages[0]).toContain(
      "The grid goes on by itself once the key works.",
    );
  });

  it("shows how to fix a refused key on the dashboard while it lasts", async () => {
    // given
    const { internals } = attentionBot();
    let refused = 1;
    const listOrders = internals._client.getActiveOrders as (
      ...args: unknown[]
    ) => Promise<unknown>;
    internals._client.getActiveOrders = vi.fn(async (...args: unknown[]) => {
      if (refused-- > 0) throw new AuthenticationError("Unauthorized");
      return listOrders(...args);
    });
    internals._running = true;
    const seen: string[][] = [];
    let ticks = 2;
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () => {
        seen.push(internals._attentionLines());
        return ticks-- > 0
          ? { price: new Decimal("100"), timestamp: Date.now() }
          : null;
      },
    };

    // when
    await internals._loop();

    // then
    expect(seen[1]).toContain(
      "Revolut X refused the API key with 401 Unauthorized. Check it with revx configure, then start the grid again.",
    );
    expect(seen[2].some((line) => line.includes("refused"))).toBe(false);
  });

  it("gives the key advice when the exchange refuses a placement", async () => {
    // given
    const { state, internals } = attentionBot({
      placeOrder: vi.fn(async () => {
        throw new ForbiddenError("Forbidden");
      }),
    });

    // when
    await internals._placeBuyOrAlert(state.levels[0]);

    // then
    expect(internals._attentionLines()).toContain(
      "Buy @99 not placed: Revolut X refused the API key with 403 Forbidden. Check its permissions in Revolut X",
    );
  });

  it("counts failing order reads as an outage even while prices come in", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { internals, notify } = attentionBot();
    internals._client.getActiveOrders = vi.fn(async () => {
      throw new Error("Service unavailable");
    });
    const gaps = [0, OUTAGE_ALERT_MS + 1000];
    internals._running = true;
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () => {
        const gap = gaps.shift();
        if (gap === undefined) return null;
        vi.setSystemTime(Date.now() + gap);
        return { price: new Decimal("100"), timestamp: Date.now() };
      },
    };

    // when
    await internals._loop();

    // then
    expect(notify.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringContaining(
        "Grid Bot BTC-USD: no data from Revolut X for 5 minutes. Still trying.\nLast error: Failed to fetch active orders: Service unavailable",
      ),
    );
  });

  it("sends one message after 5 minutes without prices and one when they are back", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { internals, notify } = attentionBot({
      placeOrder: vi.fn(async (request: Request) => accepted(request)),
    });
    const ticks: (Error | Decimal)[] = [
      new Error("fetch failed"),
      new Error("fetch failed"),
      new Error("fetch failed"),
      new Decimal("100"),
    ];
    const gaps = [0, OUTAGE_ALERT_MS - 1000, 2000, 1000];
    internals._running = true;
    internals._priceSource = {
      peek: async () => new Decimal("100"),
      next: async () => {
        const gap = gaps.shift();
        if (gap === undefined) return null;
        vi.setSystemTime(Date.now() + gap);
        const tick = ticks.shift()!;
        if (tick instanceof Error) throw tick;
        return { price: tick, timestamp: Date.now() };
      },
    };

    // when
    await internals._loop();

    // then
    const messages = notify.mock.calls.map((call) => String(call[0]));
    const outage = messages.filter((m) => m.includes("Revolut X"));
    expect(outage).toEqual([
      expect.stringContaining(
        "Grid Bot BTC-USD: no data from Revolut X for 5 minutes. Still trying.",
      ),
      "Grid Bot BTC-USD: data from Revolut X is back after 5 minutes.",
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing for a sell that failed and then went out in the same check", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockImplementationOnce(async (request: Request) => accepted(request));
    const { state, internals, notify } = attentionBot({ placeOrder });
    const position = heldPosition();
    state.levels[0].positions = [position];

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();

    // then
    expect(notify).not.toHaveBeenCalled();
    expect(internals._attentionLines()).toEqual([]);
  });

  it("sends one alert and shows one line for a sell that failed twice in a check", async () => {
    // given
    const { state, internals, notify } = attentionBot();
    const position = heldPosition();
    state.levels[0].positions = [position];

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();

    // then
    expect(notify).toHaveBeenCalledTimes(1);
    expect(internals._attentionLines()).toEqual([
      "Sell @99.1 not placed: Insufficient balance",
    ]);
    expect(internals._warnings.join(" ")).not.toContain("Insufficient balance");
  });

  it("shows a buy that failed at start-up with its latest reason until it goes out", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    let available = "2";
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("Insufficient balance"))
      .mockImplementation(async (request: Request) => accepted(request));
    const { state, internals } = attentionBot({
      placeOrder,
      available: () => available,
      historical: [
        {
          id: "old-leftover",
          client_order_id: "stale",
          status: "cancelled",
          filled_quantity: "0",
        } as Order,
      ],
    });
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };
    await internals._reconcileAndInit(state);
    await internals._tick(new Decimal("100"));
    const afterFirstCheck = internals._attentionLines();
    vi.setSystemTime(Date.now() + 61_000);
    await internals._tick(new Decimal("100"));
    const whileCashIsShort = internals._attentionLines();
    available = "1000";
    vi.setSystemTime(Date.now() + 61_000);

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(afterFirstCheck).toEqual([
      "2 buys wait for cash: $2.00 free, $20.00 needed",
      "Buy @99 not placed: Insufficient balance",
    ]);
    expect(whileCashIsShort).toEqual([
      "2 buys wait for cash: $2.00 free, $20.00 needed",
      "Buy @99 not placed: not enough USD, $2.00 free",
    ]);
    expect(internals._attentionLines()).toEqual([]);
  });

  it("says how many buys wait for cash", async () => {
    // given
    const { internals } = attentionBot({ available: () => "2" });

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(internals._attentionLines()).toEqual([
      "3 buys wait for cash: $2.00 free, $30.00 needed",
    ]);
  });

  it("uses the singular for one buy waiting for cash", async () => {
    // given
    const { state, internals } = attentionBot({ available: () => "2" });
    state.levels[1].buyOrderIds = ["buy-at-1"];
    state.levels[2].buyOrderIds = ["buy-at-2"];
    internals._client.getActiveOrders = vi.fn(async () => ({
      data: [
        { id: "buy-at-1", status: "new" },
        { id: "buy-at-2", status: "new" },
      ],
      metadata: {},
    }));

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(internals._attentionLines()).toEqual([
      "1 buy waits for cash: $2.00 free, $10.00 needed",
    ]);
  });

  it("groups orders of one level that wait for the same reason", async () => {
    // given
    const { state, internals } = attentionBot();

    // when
    await internals._placeBuyOrAlert(state.levels[0]);
    await internals._placeBuyOrAlert(state.levels[0]);

    // then
    expect(internals._attentionLines()).toEqual([
      "2 buys @99 not placed: Insufficient balance",
    ]);
  });

  it("says a pending buy without a known failure is not confirmed yet", async () => {
    // given
    const { state, internals } = attentionBot();
    state.levels[0].pendingBuyClientOrderIds = ["lost"];

    // when
    const lines = internals._attentionLines();

    // then
    expect(lines).toEqual([
      "Buy @99 not confirmed yet, looked up once a minute",
    ]);
  });

  it("shows nothing to place while selling everything", async () => {
    // given
    const { state, internals } = attentionBot();
    const position = heldPosition();
    state.levels[0].positions = [position];
    await internals._placeSellOnLevel(state.levels[1], position);

    // when
    state.halt = { reason: "stop-loss" };

    // then
    expect(internals._attentionLines()).toEqual([]);
  });

  it("shows nothing once the bot is no longer running", async () => {
    // given
    const { state, internals } = attentionBot();
    state.levels[0].pendingBuyClientOrderIds = ["lost"];

    // when
    (internals as unknown as { _lifecycle: string })._lifecycle = "finished";

    // then
    expect(internals._attentionLines()).toEqual([]);
  });

  function refillBot(level0: {
    expectedBuys: number;
    sizes: Record<string, string>;
  }) {
    const placeOrder = vi.fn(async (request: Request) => accepted(request));
    const { state, internals } = attentionBot({ placeOrder });
    state.levels[0].expectedBuys = level0.expectedBuys;
    state.levels[0].buyOrderIds = Object.keys(level0.sizes);
    state.levels[0].buyOrderQuoteSizes = level0.sizes;
    state.levels[1].buyOrderIds = ["buy-at-1"];
    state.levels[2].buyOrderIds = ["buy-at-2"];
    internals._client.getActiveOrders = vi.fn(async () => ({
      data: [...Object.keys(level0.sizes), "buy-at-1", "buy-at-2"].map(
        (id) => ({ id, status: "new" }),
      ),
      metadata: {},
    }));
    const placedAt99 = () =>
      placeOrder.mock.calls
        .map(
          ([request]) =>
            request as unknown as {
              limit: { price: string; quoteSize: string };
            },
        )
        .filter((request) => request.limit.price === "99")
        .map((request) => request.limit.quoteSize);
    return { internals, placedAt99 };
  }

  it("refills a two-slot level by the money it is missing, not by its order count", async () => {
    // given
    const { internals, placedAt99 } = refillBot({
      expectedBuys: 2,
      sizes: { rebuy: "6", leftover: "4" },
    });

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(placedAt99()).toEqual(["10"]);
  });

  it("doesn't refill a level whose one re-buy already holds both slots", async () => {
    // given
    const { internals, placedAt99 } = refillBot({
      expectedBuys: 2,
      sizes: { rebuy: "20" },
    });

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(placedAt99()).toEqual([]);
  });

  it("tops up a level by the amount of a leftover it lost", async () => {
    // given
    const { internals, placedAt99 } = refillBot({
      expectedBuys: 1,
      sizes: { rebuy: "6" },
    });

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(placedAt99()).toEqual(["4"]);
  });

  it("counts a pending buy's amount as held when refilling", async () => {
    // given
    const { internals, placedAt99 } = refillBot({
      expectedBuys: 2,
      sizes: { rebuy: "6" },
    });
    const state = (internals as unknown as { _state: GridState })._state;
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "4" };

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(placedAt99()).toEqual(["10"]);
  });

  it("skips a top-up too small for the exchange", async () => {
    // given
    const { internals, placedAt99 } = refillBot({
      expectedBuys: 1,
      sizes: { rebuy: "9.5" },
    });

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(placedAt99()).toEqual([]);
  });

  it("places the top-ups the free cash allows and shows the rest as waiting", async () => {
    // given
    const placeOrder = vi.fn(async (request: Request) => accepted(request));
    const { state, internals } = attentionBot({
      placeOrder,
      available: () => "7",
    });
    state.levels[0].buyOrderIds = ["rebuy"];
    state.levels[0].buyOrderQuoteSizes = { rebuy: "6" };
    state.levels[2].buyOrderIds = ["buy-at-2"];
    internals._client.getActiveOrders = vi.fn(async () => ({
      data: ["rebuy", "buy-at-2"].map((id) => ({ id, status: "new" })),
      metadata: {},
    }));

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(
      placeOrder.mock.calls.map(
        ([request]) =>
          (
            request as unknown as {
              limit: { price: string; quoteSize: string };
            }
          ).limit,
      ),
    ).toEqual([expect.objectContaining({ price: "99", quoteSize: "4" })]);
    expect(internals._attentionLines()).toEqual([
      "1 buy waits for cash: $3.00 free, $10.00 needed",
    ]);
  });

  it("says a sell is not placed yet when it isn't waiting for a lookup", () => {
    // given
    const { state, internals } = attentionBot();
    state.levels[0].positions = [heldPosition()];

    // when
    const lines = internals._attentionLines();

    // then
    expect(lines).toEqual(["Sell @99.1 not placed yet"]);
  });

  it("says a refused sell waits for the minute lookup, and not placed yet once it is found gone", () => {
    // given
    const { state, internals } = attentionBot();
    state.levels[0].positions = [
      { ...heldPosition(), sellClientOrderId: "refused-sell" },
    ];
    state.usedClientOrderIds = ["refused-sell"];
    const whileRefused = internals._attentionLines();

    // when
    state.usedClientOrderIds = [];
    state.levels[0].positions[0].sellClientOrderId = undefined;

    // then
    expect(whileRefused).toEqual([
      "Sell @99.1 rejected or already placed, looked up once a minute",
    ]);
    expect(internals._attentionLines()).toEqual(["Sell @99.1 not placed yet"]);
  });

  it("counts every missing buy of a level that holds several", async () => {
    // given
    const { state, internals } = attentionBot({ available: () => "2" });
    state.levels[0].expectedBuys = 3;
    state.levels[0].buyOrderIds = ["buy-at-0"];
    state.levels[1].buyOrderIds = ["buy-at-1"];
    state.levels[2].buyOrderIds = ["buy-at-2"];
    internals._client.getActiveOrders = vi.fn(async () => ({
      data: ["buy-at-0", "buy-at-1", "buy-at-2"].map((id) => ({
        id,
        status: "new",
      })),
      metadata: {},
    }));

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(internals._attentionLines()).toEqual([
      "2 buys wait for cash: $2.00 free, $20.00 needed",
    ]);
  });

  it("stops showing an old failure once the exchange says the order was already placed", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(
        new BadRequestError(
          "An order with the client_order_id 'x' has already been placed.",
        ),
      );
    const { state, internals } = attentionBot({ placeOrder });
    const position = heldPosition();
    state.levels[0].positions = [position];
    await internals._placeSellOnLevel(state.levels[1], position);

    // when
    await internals._placeSellOnLevel(state.levels[1], position);

    // then
    expect(internals._attentionLines()).toEqual([
      "Sell @99.1 rejected or already placed, looked up once a minute",
    ]);
  });

  it("sends no start-up alert when Ctrl+C came before the run loop", async () => {
    // given
    const { bot, state, internals, notify } = attentionBot();
    await internals._placeBuyOrAlert(state.levels[0]);
    bot.stop();

    // when
    await internals._loop();

    // then
    expect(notify).not.toHaveBeenCalled();
  });

  it("records failed buys of a trailing-up rebuild with their reason and one alert each", async () => {
    // given
    const { state, internals, notify } = attentionBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.quotePrecision = "0.01";

    // when
    await internals._rebuildGridUp(new Decimal("110"));
    internals._flushPlacementAlerts();

    // then
    const lines = internals._attentionLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^Buy @[\d.]+ not placed: Insufficient balance$/);
    }
    expect(
      notify.mock.calls.filter(([message]) =>
        String(message).includes("could not place"),
      ),
    ).toHaveLength(lines.length);
    expect(internals._warnings.join(" ")).not.toContain("Rebuild buy");
  });

  it("alerts only for failures still there at the end of a check of the run loop", async () => {
    // given
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockImplementationOnce(async (request: Request) => accepted(request))
      .mockRejectedValue(new Error("Insufficient balance"));
    const { state, internals, notify } = attentionBot({ placeOrder });
    const position = heldPosition();
    state.levels[0].positions = [position];
    const alertsDuringChecks: number[] = [];
    let check = 0;
    internals._tick = async () => {
      check++;
      if (check === 2) {
        position.sellOrderId = null;
        position.sellClientOrderId = undefined;
      }
      await internals._placeSellOnLevel(state.levels[1], position);
      if (check === 1) {
        await internals._placeSellOnLevel(state.levels[1], position);
      }
      alertsDuringChecks.push(notify.mock.calls.length);
    };

    // when
    await runChecks(internals, 2);

    // then
    expect(alertsDuringChecks).toEqual([0, 0]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain(
      "could not place the sell of 0.1 BTC at $99.1 (Insufficient balance)",
    );
  });

  it("sends a failure from start-up when the run loop starts", async () => {
    // given
    const { state, internals, notify } = attentionBot();
    await internals._placeBuyOrAlert(state.levels[0]);

    // when
    await runChecks(internals, 0);

    // then
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain(
      "could not place the buy of $10.00 at $99 (Insufficient balance)",
    );
  });

  it("sends no alert for a check that Ctrl+C interrupted", async () => {
    // given
    const { bot, state, internals, notify } = attentionBot();
    const position = heldPosition();
    state.levels[0].positions = [position];
    internals._tick = async () => {
      await internals._placeSellOnLevel(state.levels[1], position);
      bot.stop();
    };

    // when
    await runChecks(internals, 1);

    // then
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("grid bot split start-up size check", () => {
  it("refuses a split grid whose sells fall below the minimum once the buy fee is paid", async () => {
    // given
    const placeOrder = vi.fn();
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 2,
      rangePct: "0.05",
      investment: "20",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _priceSource: { peek: () => Promise<Decimal> };
      _initNewGrid: () => Promise<void>;
    };
    internals._pairInfo = {
      ...PAIR_INFO,
      quote_step: "0.01",
      min_order_size: "0.1",
    };
    internals._client = { placeOrder, getBalances };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    const init = internals._initNewGrid();

    // then
    await expect(init).rejects.toThrow(/below the minimum base order size/);
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("grid bot range alerts", () => {
  function rangeBot(options: { trailingUp?: boolean; dryRun?: boolean } = {}) {
    const state = makeState();
    state.config.dryRun = options.dryRun ?? false;
    state.quotePrecision = "0.01";
    const notify = vi.fn();
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: options.dryRun ?? false,
        reset: false,
        trailingUp: options.trailingUp ?? false,
      },
      { trailingUpConfirmationTicks: 1 },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _notify: typeof notify;
      _checkBoundary: (price: Decimal) => void;
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._notify = notify;
    const check = (prices: string[]) => {
      for (const price of prices) internals._checkBoundary(new Decimal(price));
    };
    const rangeMessages = () =>
      notify.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("exited grid range"));
    return { internals, check, rangeMessages };
  }

  it("explains what the grid holds when the price leaves the range", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["98", "99.5", "101"]);

    // then
    expect(rangeMessages()).toEqual([
      expect.stringContaining(
        "All grid levels are above the price, so the grid holds coins and waits for the price to come back to its sells",
      ),
      expect.stringContaining(
        "All grid levels are below the price, so the grid waits for the price to come back to its buys",
      ),
    ]);
  });

  it("sends one message while the price stays below the grid, and warns on every check", () => {
    // given
    const { internals, check, rangeMessages } = rangeBot();

    // when
    check(["98.9", "98.5", "98", "97"]);

    // then
    expect(rangeMessages()).toHaveLength(1);
    expect(internals._warnings).toHaveLength(4);
  });

  it("doesn't repeat it while the price hovers just above the lowest level", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["98.9", "99.09", "98.95", "99", "98.9"]);

    // then
    expect(rangeMessages()).toHaveLength(1);
  });

  it("sends it again once the price was back up at the next level", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["98.9", "99.1", "98.9"]);

    // then
    expect(rangeMessages()).toHaveLength(2);
  });

  it("doesn't repeat it while the price hovers just below the top level", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["100.1", "99.21", "99.5", "100.2"]);

    // then
    expect(rangeMessages()).toHaveLength(1);
  });

  it("sends it again once the price was back down at the level below the top", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["100.1", "99.2", "100.1"]);

    // then
    expect(rangeMessages()).toHaveLength(2);
  });

  it("sends a new message when the price leaves on the other side", () => {
    // given
    const { check, rangeMessages } = rangeBot();

    // when
    check(["98.9", "100.1", "98.9"]);

    // then
    expect(rangeMessages()).toEqual([
      expect.stringContaining("(below "),
      expect.stringContaining("(above "),
      expect.stringContaining("(below "),
    ]);
  });

  it("doesn't repeat it while trailing up waits to rebuild", () => {
    // given
    const { check, rangeMessages } = rangeBot({ trailingUp: true });

    // when
    check(["100.1", "101", "100.3", "101", "100.3"]);

    // then
    expect(rangeMessages()).toHaveLength(1);
  });

  it("listens for a new exit once trailing up has rebuilt the grid", async () => {
    // given
    const { internals, check, rangeMessages } = rangeBot({
      trailingUp: true,
      dryRun: true,
    });
    check(["100.1"]);

    // when
    await internals._rebuildGridUp(new Decimal("101"));
    const levels = internals._state.levels;
    const justAboveTop = new Decimal(levels[levels.length - 1].price).times(
      "1.001",
    );
    check([justAboveTop.toString()]);

    // then
    expect(rangeMessages()).toHaveLength(2);
  });
});

describe("grid bot without saved state", () => {
  it("never loads Telegram connections, so backtests can't message anyone", async () => {
    // given
    vi.mocked(loadConnections).mockClear();
    const state = makeState();
    state.config.dryRun = true;
    state.config.stopLoss = "90";
    state.levels[0].buyOrderIds = [];
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: true,
        reset: false,
        trailingUp: false,
        stopLoss: "90",
      },
      { persistState: false },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, never>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._client = {};

    // when
    await internals._tick(new Decimal("95"));
    await internals._tick(new Decimal("80"));

    // then
    expect(loadConnections).not.toHaveBeenCalled();
  });
});

function stopRequest(internals: object): AbortController {
  return (internals as { _stopRequest: AbortController })._stopRequest;
}

function rejectThreeTimes(internals: {
  _countRejection: (
    slot: string,
    clientOrderId: string,
    side: "buy" | "sell",
    price: string,
  ) => void;
}): void {
  for (const clientOrderId of ["first", "second", "third"]) {
    internals._countRejection("buy:2", clientOrderId, "buy", "99.2");
  }
}

describe("grid bot liquidation", () => {
  type SaleRequest = {
    clientOrderId: string;
    side: "buy" | "sell";
    market?: { baseSize?: string };
  };

  function exchangeOrder(
    id: string,
    overrides: Partial<OrderDetails> = {},
  ): OrderDetails {
    return {
      id,
      client_order_id: `client-${id}`,
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      quantity: "0.1",
      filled_quantity: "0",
      leaves_quantity: "0",
      price: "99",
      status: "cancelled",
      time_in_force: "gtc",
      execution_instructions: ["post_only"],
      created_date: 1,
      updated_date: 1,
      ...overrides,
    };
  }

  function liquidationBot(
    options: {
      orders?: Record<string, Partial<OrderDetails>>;
      sales?: Array<Partial<OrderDetails>>;
      historical?: OrderDetails[];
      stopLoss?: string;
      pairInfo?: CurrencyPair;
    } = {},
  ) {
    vi.mocked(saveGridState).mockClear();
    vi.mocked(deleteGridState).mockClear();
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    if (options.stopLoss) state.config.stopLoss = options.stopLoss;
    const sales = [...(options.sales ?? [])];
    const saleOrders = new Map<string, OrderDetails>();
    const placeOrder = vi.fn(async (request: SaleRequest) => {
      if (!request.market) {
        return {
          data: {
            venue_order_id: "rejected",
            client_order_id: request.clientOrderId,
            state: "rejected" as const,
          },
        };
      }
      const id = `sale-${saleOrders.size + 1}`;
      saleOrders.set(
        id,
        exchangeOrder(id, {
          side: "sell",
          type: "market",
          status: "filled",
          ...(sales.shift() ?? {}),
        }),
      );
      return {
        data: {
          venue_order_id: id,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    const cancelOrder = vi.fn(async () => undefined);
    const getOrder = vi.fn(async (id: string) => ({
      data: saleOrders.get(id) ?? exchangeOrder(id, options.orders?.[id]),
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(
      async (request: { startDate: number; endDate: number }) => ({
        data:
          request.startDate <= request.endDate
            ? (options.historical ?? [])
            : [],
        metadata: {},
      }),
    );
    const output: string[] = [];
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: false,
        reset: false,
        trailingUp: false,
        stopLoss: options.stopLoss,
      },
      {
        humanOutput: {
          write: (chunk: string) => {
            output.push(chunk);
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _running: boolean;
      _client: {
        placeOrder: typeof placeOrder;
        cancelOrder: typeof cancelOrder;
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _priceSource: {
        peek: () => Promise<Decimal>;
        next?: () => Promise<{ price: Decimal; timestamp: number }>;
      };
      _statusReporter: { flush: () => Promise<void>; snapshot: () => [] };
      _liquidation: Promise<void> | null;
      _loop: () => Promise<void>;
      _run: () => Promise<void>;
      _tick: (price: Decimal) => Promise<void>;
      _liquidate: (reason: string, price?: Decimal) => Promise<void>;
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
      _placeBuyOrder: (
        level: GridLevelState,
        quoteSize: Decimal,
        clientOrderId: string,
      ) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
      _countRejection: (
        slot: string,
        clientOrderId: string,
        side: "buy" | "sell",
        price: string,
      ) => void;
      _cancelUntilClosed: (
        orderId: string,
      ) => Promise<{ closed: boolean; order?: OrderDetails | null }>;
      _awaitTerminal: (orderId: string) => Promise<OrderDetails>;
    };
    internals._state = state;
    internals._pairInfo = options.pairInfo ?? PAIR_INFO;
    internals._running = true;
    internals._client = {
      placeOrder,
      cancelOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
    };
    internals._priceSource = { peek: async () => new Decimal("90") };
    return {
      bot,
      state,
      internals,
      placeOrder,
      cancelOrder,
      getActiveOrders,
      output,
    };
  }

  function position(
    id: string,
    baseHeld: string,
    fillCost: string,
    sellOrderId: string | null = null,
  ): GridLevelPosition {
    return {
      id,
      baseHeld,
      fillCost,
      sellOrderId,
      ...(sellOrderId ? { sellBaseSize: baseHeld } : {}),
    };
  }

  function marketSells(placeOrder: ReturnType<typeof vi.fn>) {
    return placeOrder.mock.calls
      .map(([request]) => request as SaleRequest)
      .filter((request) => request.market);
  }

  it("sells a buy that filled while the stop-loss was cancelling it", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      stopLoss: "95",
      orders: {
        "buy-1": {
          status: "filled",
          filled_quantity: "0.101",
          filled_amount: "10",
          average_fill_price: "99",
        },
      },
      sales: [
        {
          filled_quantity: "0.201",
          filled_amount: "17.99",
          average_fill_price: "89.5",
        },
      ],
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[1].positions = [position("p1", "0.1", "10", "sell-1")];

    // when
    await internals._tick(new Decimal("90"));

    // then
    expect(marketSells(placeOrder)).toEqual([
      expect.objectContaining({ side: "sell", market: { baseSize: "0.201" } }),
    ]);
    expect(state.levels.flatMap((level) => level.positions)).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-2.01");
    expect(state.tradeLog.at(-1)).toEqual(
      expect.objectContaining({
        side: "sell",
        price: "89.5",
        quantity: "0.201",
        orderId: "stop-loss",
      }),
    );
    expect(state.halt).toBeUndefined();
    expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
    expect(internals._running).toBe(false);
  });

  it("ends the grid after a fill found while Ctrl+C cancels, and sells nothing", async () => {
    // given
    const { bot, state, placeOrder } = liquidationBot({
      orders: {
        "buy-1": {
          status: "filled",
          filled_quantity: "0.101",
          filled_amount: "10",
        },
      },
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[1].positions = [position("p1", "0.1", "10", "sell-1")];

    // when
    await bot.shutdown();

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
  });

  it("keeps coins behind a sell whose cancel can't be confirmed and leaves the sale pending", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      sales: [{ filled_quantity: "0.05", filled_amount: "4.5" }],
    });
    state.levels[1].positions = [position("p1", "0.1", "10", "sell-1")];
    state.levels[2].positions = [position("p2", "0.05", "5")];
    internals._cancelUntilClosed = vi.fn(async (orderId: string) =>
      orderId === "sell-1"
        ? { closed: false }
        : { closed: true, order: exchangeOrder(orderId) },
    );

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(marketSells(placeOrder)).toEqual([
      expect.objectContaining({ market: { baseSize: "0.05" } }),
    ]);
    expect(state.levels[1].positions).toEqual([
      expect.objectContaining({ id: "p1", sellOrderId: "sell-1" }),
    ]);
    expect(state.levels[2].positions).toEqual([]);
    expect(state.halt).toEqual(
      expect.objectContaining({ reason: "stop-loss" }),
    );
    expect(deleteGridState).not.toHaveBeenCalled();
    expect(internals._running).toBe(false);
  });

  it("keeps the sale pending when the market sell can't be placed", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot();
    state.levels[0].positions = [position("p1", "0.1", "10")];
    placeOrder.mockImplementation(async () => {
      throw new Error("sell failed");
    });

    // when
    await internals._liquidate("stop-loss", new Decimal("80"));

    // then
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.1" }),
    ]);
    expect(state.halt).toEqual(
      expect.objectContaining({ reason: "stop-loss" }),
    );
    expect(deleteGridState).not.toHaveBeenCalled();
  });

  it("keeps an order whose cancel can't be confirmed and leaves the sale pending", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("80")),
    );

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.halt).toBeDefined();
  });

  it("finishes and deletes the saved grid when there is nothing to sell", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];

    // when
    await internals._liquidate("rejected-orders", new Decimal("90"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.halt).toBeUndefined();
    expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
  });

  it("writes off a position below the exchange minimum instead of selling it", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot();
    state.levels[0].positions = [position("dust", "0.0009", "0.09")];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-0.09");
    expect(state.halt).toBeUndefined();
    expect(deleteGridState).toHaveBeenCalled();
  });

  it("sells split coins that were not yet placed on a level at their split cost", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      sales: [{ filled_quantity: "0.2", filled_amount: "18" }],
    });
    state.initializing = true;
    state.splitExecuted = true;
    state.splitAccountingApplied = true;
    state.splitAccumulatedBase = "0.2";
    state.splitAccumulatedAmount = "20";
    state.splitAccumulatedFee = "0";

    // when
    await internals._liquidate("rejected-orders", new Decimal("90"));

    // then
    expect(marketSells(placeOrder)).toEqual([
      expect.objectContaining({ market: { baseSize: "0.2" } }),
    ]);
    expect(state.stats.realizedPnl).toBe("-2");
    expect(state.splitAccumulatedBase).toBeUndefined();
    expect(state.halt).toBeUndefined();
  });

  async function throughTheWait(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const done = run();
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  }

  function sellOffMessage(internals: object): string {
    return (internals as { _sellOffMessage: string })._sellOffMessage;
  }

  it("says which cancel kept the sell-off from finishing", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[1].positions = [position("p1", "0.1", "10")];
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(marketSells(placeOrder)).toHaveLength(1);
    expect(state.halt).toBeDefined();
    expect(sellOffMessage(internals)).toMatch(
      /The sale will finish on the next start\..*\nLast error: Order buy-1 did not reach a cancelled state\.$/s,
    );
  });

  it("counts the other cancels that couldn't be confirmed", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[1].buyOrderIds = ["buy-2", "buy-3"];
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(sellOffMessage(internals)).toMatch(
      /\nLast error: Order buy-1 did not reach a cancelled state\. 2 more orders didn't either\.$/,
    );
  });

  it("waits in the same run for a sale whose fill isn't confirmed yet", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];
    const confirm = internals._awaitTerminal.bind(internals);
    let lookups = 0;
    internals._awaitTerminal = async (orderId: string) => {
      lookups++;
      if (lookups === 1) {
        throw new Error(`Order ${orderId} did not settle within 30 seconds.`);
      }
      return confirm(orderId);
    };

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(marketSells(placeOrder)).toHaveLength(1);
    expect(state.halt).toBeUndefined();
    expect(state.levels[1].positions).toEqual([]);
  });

  it("sends no sale that waits for its turn when Ctrl+C comes", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot();
    state.levels[1].positions = [position("p1", "0.1", "10")];
    (
      internals as unknown as {
        _rateLimiter: {
          place: (
            operation: () => Promise<unknown>,
            refuse?: () => Error | null,
          ) => Promise<unknown>;
        };
      }
    )._rateLimiter.place = async (operation, refuse) => {
      stopRequest(internals).abort();
      const refusal = refuse?.();
      if (refusal) throw refusal;
      return operation();
    };

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(marketSells(placeOrder)).toEqual([]);
    expect(state.halt).toBeDefined();
    expect(state.halt?.clientOrderId).toBeUndefined();
    expect(sellOffMessage(internals)).toMatch(
      /\nLast error: Stopped by Ctrl\+C before the next sale\.$/,
    );
  });

  it("names an order replaced outside the bot instead of counting it as cancelled", async () => {
    // given
    const { state, internals } = liquidationBot({
      orders: { "buy-x": { reject_reason: "replaced" } },
    });
    state.levels[0].buyOrderIds = ["buy-x"];
    state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    const message = sellOffMessage(internals);
    expect(message).not.toContain("Cancelled");
    expect(message).toContain(
      "\n1 order was replaced outside the bot. The replacement isn't tracked and wasn't cancelled. Check revx order open.",
    );
  });

  it("says the last sale sent isn't confirmed when the wait ends", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.levels[1].positions = [position("p1", "0.1", "10")];
    internals._awaitTerminal = async (orderId: string) => {
      throw new Error(`Order ${orderId} did not settle within 30 seconds.`);
    };

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(sellOffMessage(internals)).toContain(
      "still holding 0.1 BTC. The last sale sent isn't confirmed yet. The sale will finish on the next start.",
    );
  });

  it("says when the last three sales filled nothing", async () => {
    // given
    const empty = { status: "cancelled" as const, filled_quantity: "0" };
    const { state, internals } = liquidationBot({
      sales: [empty, empty, empty],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(state.halt).toBeDefined();
    expect(sellOffMessage(internals)).toMatch(
      /\nLast error: The last 3 sales filled nothing\.$/,
    );
  });

  it("keeps a guard message for grid orders still tracked after the cancel step", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    (
      internals as unknown as {
        _closeGridOrders: () => Promise<{
          cancelled: number;
          problems: string[];
          unlisted: string[];
        }>;
      }
    )._closeGridOrders = vi.fn(async () => ({
      cancelled: 0,
      problems: [],
      unlisted: [],
    }));

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(state.halt).toBeDefined();
    expect(sellOffMessage(internals)).toMatch(
      /\nLast error: Some grid orders are not confirmed closed yet\.$/,
    );
  });

  it("gives no last error when the sell-off finishes", async () => {
    // given
    const { state, internals } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(state.halt).toBeUndefined();
    expect(sellOffMessage(internals)).not.toContain("Last error");
  });

  describe("orders with a lost reply during a sell-off", () => {
    const FIVE_MINUTES = 5 * 60 * 1000;
    const UNCONFIRMED =
      /\nLast error: 1 order sent before the sell-off isn't confirmed yet\. The next start looks again and gives up on any still missing after 5 minutes\.$/;

    afterEach(() => {
      vi.useRealTimers();
    });

    function lostSplit(state: GridState): void {
      state.splitClientOrderId = "split-lost";
      state.splitOrderQuoteSize = "20";
    }

    async function liquidateThenStop(
      bot: ForegroundGridBot,
      internals: object,
    ): Promise<void> {
      const stoppable = internals as {
        _liquidate: (reason: "stop-loss", price: Decimal) => Promise<void>;
        _printSellOff: () => void;
      };
      stoppable._printSellOff = () => undefined;
      const selling = stoppable._liquidate("stop-loss", new Decimal("90"));
      await vi.advanceTimersByTimeAsync(0);
      const stopping = bot.shutdown();
      await selling;
      await stopping;
    }

    function lostSell(state: GridState): GridLevelPosition {
      const held = {
        ...position("p-lost", "0.1", "10"),
        sellClientOrderId: "lost-sell",
        sellBaseSize: "0.1",
      };
      state.levels[0].positions = [held];
      return held;
    }

    it("names a cancel problem before orders that aren't confirmed yet", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals } = liquidationBot();
      state.levels[0].buyOrderIds = ["buy-1"];
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy"];
      state.levels[1].pendingBuyQuoteSizes = { "lost-buy": "10" };
      internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(state.levels[1].pendingBuyClientOrderIds).toEqual(["lost-buy"]);
      expect(sellOffMessage(internals)).toMatch(
        /\nLast error: Order buy-1 did not reach a cancelled state\.$/,
      );
    });

    it("keeps a split buy it can't find yet and still sells the coins it knows about, when stopped while it waits", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals, placeOrder } = liquidationBot({
        sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
      });
      lostSplit(state);
      state.levels[1].positions = [position("p1", "0.1", "10")];

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(marketSells(placeOrder)).toHaveLength(1);
      expect(state.splitClientOrderId).toBe("split-lost");
      expect(state.missingSince).toEqual({
        "split-lost": new Date().toISOString(),
      });
      expect(state.halt).toBeDefined();
      expect(sellOffMessage(internals)).toMatch(UNCONFIRMED);
    });

    it("keeps waiting when the next lookup comes just under five minutes after the first miss, when stopped while it waits", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals } = liquidationBot();
      lostSplit(state);
      const firstMiss = new Date(Date.now() - FIVE_MINUTES + 1).toISOString();
      state.missingSince = { "split-lost": firstMiss };

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(state.splitClientOrderId).toBe("split-lost");
      expect(state.missingSince).toEqual({ "split-lost": firstMiss });
      expect(state.halt).toBeDefined();
    });

    it("waits for a sell it can't find yet and sells its coins once it has been missing for five minutes", async () => {
      // given
      vi.useFakeTimers();
      const { state, internals, placeOrder } = liquidationBot({
        sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
      });
      const held = lostSell(state);

      // when
      const selling = internals._liquidate("stop-loss", new Decimal("90"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await selling;

      // then
      expect(marketSells(placeOrder)).toEqual([
        expect.objectContaining({ market: { baseSize: "0.1" } }),
      ]);
      expect(held.sellClientOrderId).toBeUndefined();
      expect(state.halt).toBeUndefined();
    });

    it("treats a split buy still missing five minutes after the first miss as never placed", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals } = liquidationBot();
      lostSplit(state);
      state.missingSince = {
        "split-lost": new Date(Date.now() - FIVE_MINUTES).toISOString(),
      };

      // when
      await internals._liquidate("stop-loss", new Decimal("90"));

      // then
      expect(state.splitClientOrderId).toBeUndefined();
      expect(state.missingSince).toEqual({});
      expect(state.halt).toBeUndefined();
    });

    it("sells the split coins once the split buy is found", async () => {
      // given
      const filledSplit = {
        client_order_id: "split-lost",
        side: "buy" as const,
        type: "market" as const,
        status: "filled" as const,
        quantity: "0.2",
        filled_quantity: "0.2",
        filled_amount: "20",
        average_fill_price: "100",
      };
      const { state, internals, placeOrder } = liquidationBot({
        historical: [exchangeOrder("split-1", filledSplit)],
        orders: { "split-1": filledSplit },
        sales: [{ filled_quantity: "0.2", filled_amount: "18" }],
      });
      lostSplit(state);
      state.missingSince = {
        "split-lost": new Date(Date.now() - 60_000).toISOString(),
      };

      // when
      await internals._liquidate("stop-loss", new Decimal("90"));

      // then
      expect(marketSells(placeOrder)).toEqual([
        expect.objectContaining({ market: { baseSize: "0.2" } }),
      ]);
      expect(state.splitClientOrderId).toBeUndefined();
      expect(state.missingSince).toEqual({});
      expect(state.halt).toBeUndefined();
    });

    it("neither sells nor writes off the coins of a sell it can't find yet, when stopped while it waits", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals, placeOrder } = liquidationBot();
      const held = lostSell(state);

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(marketSells(placeOrder)).toEqual([]);
      expect(state.levels[0].positions).toEqual([held]);
      expect(held.sellClientOrderId).toBe("lost-sell");
      expect(state.stats.realizedPnl).toBe("0");
      expect(state.halt).toBeDefined();
      expect(sellOffMessage(internals)).toMatch(UNCONFIRMED);
    });

    it("sells those coins once the sell is still missing five minutes later", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals, placeOrder } = liquidationBot({
        sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
      });
      const held = lostSell(state);
      state.missingSince = {
        "lost-sell": new Date(Date.now() - FIVE_MINUTES).toISOString(),
      };

      // when
      await internals._liquidate("stop-loss", new Decimal("90"));

      // then
      expect(marketSells(placeOrder)).toEqual([
        expect.objectContaining({ market: { baseSize: "0.1" } }),
      ]);
      expect(held.sellClientOrderId).toBeUndefined();
      expect(state.halt).toBeUndefined();
    });

    it("writes nothing off while an order isn't confirmed yet, when stopped while it waits", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals } = liquidationBot();
      lostSell(state);
      const dust = position("dust", "0.0009", "0.09");
      state.levels[1].positions = [dust];

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(state.levels[1].positions).toEqual([dust]);
      expect(state.stats.realizedPnl).toBe("0");
      expect(state.halt).toBeDefined();
    });

    it("forgets the first miss of a sell it finds on a later start", async () => {
      // given
      const { state, internals, placeOrder } = liquidationBot({
        historical: [
          exchangeOrder("lost-sell-order", {
            client_order_id: "lost-sell",
            side: "sell",
            status: "cancelled",
          }),
        ],
        sales: [{ filled_quantity: "0.1", filled_amount: "9" }],
      });
      const held = lostSell(state);
      state.missingSince = {
        "lost-sell": new Date(Date.now() - 60_000).toISOString(),
      };

      // when
      await internals._liquidate("stop-loss", new Decimal("90"));

      // then
      expect(state.missingSince).toEqual({});
      expect(held.sellClientOrderId).toBeUndefined();
      expect(marketSells(placeOrder)).toEqual([
        expect.objectContaining({ market: { baseSize: "0.1" } }),
      ]);
      expect(state.halt).toBeUndefined();
    });

    it("keeps a buy it can't find yet instead of forgetting it, when stopped while it waits", async () => {
      // given
      vi.useFakeTimers();
      const { bot, state, internals } = liquidationBot();
      state.levels[0].pendingBuyClientOrderIds = ["lost-buy"];
      state.levels[0].pendingBuyQuoteSizes = { "lost-buy": "10" };

      // when
      await liquidateThenStop(bot, internals);

      // then
      expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["lost-buy"]);
      expect(state.halt).toBeDefined();
      expect(sellOffMessage(internals)).toMatch(UNCONFIRMED);
    });
  });

  it("books a partial sale, retries the rest with a new id and still stops when reporting fails", async () => {
    // given
    const savedSnapshots: GridState[] = [];
    const { state, internals, placeOrder } = liquidationBot({
      sales: [
        {
          status: "cancelled",
          filled_quantity: "0.04",
          filled_amount: "3.6",
        },
        { filled_quantity: "0.06", filled_amount: "5.4" },
      ],
    });
    vi.mocked(saveGridState).mockImplementation((savedState) => {
      savedSnapshots.push(structuredClone(savedState));
    });
    state.levels[0].positions = [position("p1", "0.1", "10")];
    internals._statusReporter = {
      flush: vi.fn(async () => {
        throw new Error("report failed");
      }),
      snapshot: () => [],
    };

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    const sells = marketSells(placeOrder);
    expect(sells.map((request) => request.market?.baseSize)).toEqual([
      "0.1",
      "0.06",
    ]);
    expect(sells[0].clientOrderId).not.toBe(sells[1].clientOrderId);
    expect(
      savedSnapshots.some(
        (snapshot) =>
          snapshot.levels[0].positions[0]?.baseHeld === "0.06" &&
          snapshot.halt !== undefined,
      ),
    ).toBe(true);
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-1");
    expect(internals._running).toBe(false);
    vi.mocked(saveGridState).mockReset();
  });

  it("sells in pieces no larger than the exchange maximum", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      pairInfo: { ...PAIR_INFO, max_order_size: "0.1" },
      sales: [
        { filled_quantity: "0.1", filled_amount: "9" },
        { filled_quantity: "0.1", filled_amount: "9" },
        { filled_quantity: "0.05", filled_amount: "4.5" },
      ],
    });
    state.levels[0].positions = [position("p1", "0.25", "25")];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(
      marketSells(placeOrder).map((request) => request.market?.baseSize),
    ).toEqual(["0.1", "0.1", "0.05"]);
    expect(state.levels[0].positions).toEqual([]);
    expect(state.halt).toBeUndefined();
  });

  it("finishes an interrupted sale on restart from its order id", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      orders: {
        "old-sale": {
          side: "sell",
          type: "market",
          status: "filled",
          filled_quantity: "0.1",
          filled_amount: "9",
        },
      },
    });
    state.levels[0].positions = [position("p1", "0.1", "10")];
    state.halt = {
      reason: "stop-loss",
      clientOrderId: "client-old-sale",
      orderId: "old-sale",
    };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-1");
    expect(state.halt).toBeUndefined();
    expect(deleteGridState).toHaveBeenCalled();
  });

  it("never charges a resumed sale to coins behind a live sell", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      orders: {
        "old-sale": {
          side: "sell",
          type: "market",
          status: "filled",
          filled_quantity: "0.1",
          filled_amount: "9",
        },
      },
    });
    state.levels[0].positions = [position("pA", "0.1", "10", "sell-A")];
    state.levels[1].positions = [position("pB", "0.1", "10")];
    state.halt = {
      reason: "stop-loss",
      orderId: "old-sale",
    };
    internals._cancelUntilClosed = vi.fn(async (orderId: string) =>
      orderId === "sell-A"
        ? { closed: false }
        : { closed: true, order: exchangeOrder(orderId) },
    );

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ id: "pA", sellOrderId: "sell-A" }),
    ]);
    expect(state.levels[1].positions).toEqual([]);
    expect(marketSells(placeOrder)).toEqual([]);
    expect(state.halt).toBeDefined();
  });

  it("still cancels every order when an earlier sell-off step fails", async () => {
    // given
    const { state, internals, placeOrder, cancelOrder, getActiveOrders } =
      liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[1].pendingBuyClientOrderIds = ["stale-client"];
    state.levels[1].positions = [position("p1", "0.1", "10")];
    getActiveOrders.mockImplementation(async () => {
      throw new Error("exchange unavailable");
    });

    // when
    await throughTheWait(() =>
      internals._liquidate("stop-loss", new Decimal("90")),
    );

    // then
    expect(cancelOrder).toHaveBeenCalledWith("buy-1");
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(marketSells(placeOrder)).toEqual([]);
    expect(state.halt).toBeDefined();
  });

  it("gives up after three sales that fill nothing and leaves the sale pending", async () => {
    // given
    const empty = { status: "cancelled", filled_quantity: "0" } as const;
    const { state, internals, placeOrder } = liquidationBot({
      sales: [empty, empty, empty, empty],
    });
    state.levels[0].positions = [position("p1", "0.1", "10")];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(marketSells(placeOrder)).toHaveLength(3);
    expect(state.levels[0].positions).toHaveLength(1);
    expect(state.halt).toBeDefined();
  });

  it("finishes an interrupted sale found by its client id", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      historical: [
        exchangeOrder("found-sale", {
          client_order_id: "client-9",
          side: "sell",
          type: "market",
          status: "filled",
          filled_quantity: "0.1",
          filled_amount: "9",
        }),
      ],
      orders: {
        "found-sale": {
          side: "sell",
          type: "market",
          status: "filled",
          filled_quantity: "0.1",
          filled_amount: "9",
        },
      },
    });
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.levels[0].positions = [position("p1", "0.1", "10")];
    state.halt = {
      reason: "stop-loss",
      clientOrderId: "client-9",
    };

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.realizedPnl).toBe("-1");
    expect(state.halt).toBeUndefined();
  });

  it("refuses to finish a pending live sell-off in dry-run mode", () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss" };
    const dryRunBot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: false,
    }) as unknown as { _assertHaltedModeMatches: (saved: GridState) => void };

    // when
    const check = () => dryRunBot._assertHaltedModeMatches(state);

    // then
    expect(check).toThrow(/live mode/);
    expect(internals._state.config.dryRun).toBe(false);
  });

  it("sells everything when an order is rejected three times", async () => {
    // given
    const { bot, state, internals, placeOrder, output } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "9.5" }],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];
    internals._run = async () => rejectThreeTimes(internals);

    // when
    const run = bot.run();

    // then
    await expect(run).rejects.toMatchObject({
      name: "OrderRejectedError",
    });
    expect(marketSells(placeOrder)).toEqual([
      expect.objectContaining({ market: { baseSize: "0.1" } }),
    ]);
    expect(state.tradeLog.at(-1)).toEqual(
      expect.objectContaining({ orderId: "close-all", quantity: "0.1" }),
    );
    expect(state.halt).toBeUndefined();
    expect(deleteGridState).toHaveBeenCalled();
    expect(output.join("")).toContain("EMERGENCY STOP");
  });

  it("leaves a sell-off that Ctrl+C interrupts for the next start", async () => {
    // given
    const { bot, state, internals, placeOrder } = liquidationBot();
    state.levels[1].positions = [position("p1", "0.1", "10")];
    placeOrder.mockImplementation(async () => {
      throw new Error("sell failed");
    });
    const selling = internals
      ._liquidate("stop-loss", new Decimal("90"))
      .catch(() => undefined);

    // when
    await bot.shutdown();
    await selling;

    // then
    expect(state.halt).toBeDefined();
    expect(state.stopped).toBeUndefined();
    expect(deleteGridState).not.toHaveBeenCalled();
  });

  it("starts the emergency sell-off from the loop so Ctrl+C can wait for it", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "9.5" }],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];
    internals._priceSource = {
      peek: async () => new Decimal("90"),
      next: async () => ({ price: new Decimal("90"), timestamp: 1 }),
    };
    internals._tick = async () => rejectThreeTimes(internals);

    // when
    const loop = internals._loop();

    // then
    await expect(loop).rejects.toMatchObject({
      name: "OrderRejectedError",
    });
    expect(internals._liquidation).not.toBeNull();
    await internals._liquidation;
    expect(marketSells(placeOrder)).toHaveLength(1);
    expect(state.halt).toBeUndefined();
  });

  it("reports the sell-off error, not an earlier retry warning", async () => {
    // given
    const { bot, state, internals, placeOrder, output } = liquidationBot();
    state.levels[1].positions = [position("p1", "0.1", "10")];
    placeOrder.mockImplementation(async (request: SaleRequest) => {
      if (request.market) throw new Error("sell failed");
      return {
        data: {
          venue_order_id: "rejected",
          client_order_id: request.clientOrderId,
          state: "rejected" as const,
        },
      };
    });
    internals._run = async () => rejectThreeTimes(internals);

    // when
    const run = bot.run();

    // then
    await expect(run).rejects.toMatchObject({
      name: "OrderRejectedError",
    });
    const printed = output.join("");
    expect(printed).toContain("Last error: Sell-off order: sell failed");
    expect(printed).not.toContain("retrying");
    expect(state.halt).toBeDefined();
  });

  it("books and sells what a rejected sell traded when rejections stop the grid", async () => {
    // given
    const traded = {
      side: "sell",
      status: "rejected",
      filled_quantity: "0.04",
      filled_amount: "3.964",
      total_fee: "0",
      fee_currency: "USD",
    } as const;
    const { bot, state, internals, placeOrder } = liquidationBot({
      historical: [
        exchangeOrder("rejected-sell", {
          ...traded,
          client_order_id: "held-sell",
        }),
      ],
      orders: { "rejected-sell": traded },
      sales: [
        {
          filled_quantity: "0.06",
          filled_amount: "5.4",
          average_fill_price: "90",
        },
      ],
    });
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.levels[0].positions = [
      {
        ...position("p1", "0.1", "10"),
        sellClientOrderId: "held-sell",
        sellBaseSize: "0.1",
      },
    ];
    internals._run = async () => rejectThreeTimes(internals);

    // when
    const run = bot.run();

    // then
    await expect(run).rejects.toMatchObject({
      name: "OrderRejectedError",
    });
    expect(marketSells(placeOrder)).toEqual([
      expect.objectContaining({ market: { baseSize: "0.06" } }),
    ]);
    expect(state.stats.totalSells).toBe(2);
    expect(state.halt).toBeUndefined();
  });

  it("does not count rejections it finds while selling everything", async () => {
    // given
    const { state, internals, placeOrder } = liquidationBot({
      historical: ["first", "stale"].map((clientOrderId) =>
        exchangeOrder(`${clientOrderId}-order`, {
          client_order_id: clientOrderId,
          status: "rejected",
        }),
      ),
      sales: [
        {
          filled_quantity: "0.1",
          filled_amount: "9",
          average_fill_price: "90",
        },
      ],
    });
    state.levels[1].positions = [position("p1", "0.1", "10")];
    state.levels[0].pendingBuyClientOrderIds = ["first", "stale"];
    state.levels[0].pendingBuyQuoteSizes = { first: "10", stale: "10" };
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    state.missingSince = { first: tenMinutesAgo, stale: tenMinutesAgo };
    state.usedClientOrderIds = ["first", "stale"];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(marketSells(placeOrder)).toHaveLength(1);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(state.halt).toBeUndefined();
  });

  it("makes Ctrl+C wait for a running sale instead of cancelling again", async () => {
    // given
    const { bot, state, internals, cancelOrder } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[1].positions = [position("p1", "0.1", "10")];
    let releaseSale!: (order: OrderDetails) => void;
    internals._awaitTerminal = vi.fn(
      () =>
        new Promise<OrderDetails>((resolve) => {
          releaseSale = resolve;
        }),
    );
    const liquidation = internals._liquidate("stop-loss", new Decimal("90"));
    await vi.waitFor(() => expect(internals._awaitTerminal).toHaveBeenCalled());
    let shutdownFinished = false;

    // when
    const shutdown = bot.shutdown().then(() => {
      shutdownFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // then
    expect(shutdownFinished).toBe(false);
    releaseSale(
      exchangeOrder("sale-1", {
        side: "sell",
        type: "market",
        status: "filled",
        filled_quantity: "0.1",
        filled_amount: "9",
      }),
    );
    await liquidation;
    await shutdown;
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[1].positions).toEqual([]);
    expect(deleteGridState).toHaveBeenCalled();
  });

  it("names the full stop price and how many grid orders it cancelled", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.levels[0].buyOrderIds = ["buy-1"];

    // when
    await internals._liquidate("stop-loss", new Decimal("0.00145"));

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered at $0.00145. Cancelled 1 grid order.",
    );
  });

  it("does not count an order that filled during the cancel as cancelled", async () => {
    // given
    const { state, internals } = liquidationBot({
      orders: {
        "buy-1": {
          status: "filled",
          filled_quantity: "0.101",
          filled_amount: "10",
          average_fill_price: "99",
        },
      },
      sales: [{ filled_quantity: "0.101", filled_amount: "9.09" }],
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[1].buyOrderIds = ["buy-2"];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain("Cancelled 1 grid order.");
  });

  it("leaves out the average when a fill doesn't say what it got", async () => {
    // given
    const { state, internals } = liquidationBot({
      sales: [{ filled_quantity: "0.1" }],
    });
    state.levels[1].positions = [
      { id: "p1", baseHeld: "0.1", fillCost: "10", sellOrderId: null },
    ];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain("Sold 0.1 BTC.");
    expect(sellOffMessage(internals)).not.toContain("at avg");
  });

  it("reports the average price the sale actually got", async () => {
    // given
    const { state, internals } = liquidationBot({
      sales: [{ filled_quantity: "0.1", filled_amount: "8.5" }],
    });
    state.levels[1].positions = [
      { id: "p1", baseHeld: "0.1", fillCost: "10", sellOrderId: null },
    ];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered at $90.00.",
    );
    expect(sellOffMessage(internals)).toContain("Sold 0.1 BTC at avg $85.00.");
  });

  it("names no price when the exchange gave none before a first stop", async () => {
    // given
    const { internals } = liquidationBot();
    internals._currentPrice = null;
    internals._getCurrentPrice = vi.fn(async () => {
      throw new Error("ticker down");
    });

    // when
    await internals._liquidate("rejected-orders");

    // then
    expect(sellOffMessage(internals)).toContain(
      "EMERGENCY STOP after 3 rejected orders. ",
    );
    expect(sellOffMessage(internals)).not.toContain("$100");
  });

  it("keeps a tiny trigger price across a restart", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss", triggerPrice: "0.00000011" };
    internals._getCurrentPrice = vi.fn(async () => new Decimal("1e-7"));

    // when
    await internals._liquidate("stop-loss");

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered at $0.00000011, sale finished after a restart.",
    );
  });

  it("does not count an order the exchange had rejected as cancelled", async () => {
    // given
    const { state, internals } = liquidationBot({
      orders: { "buy-1": { status: "rejected" } },
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[1].buyOrderIds = ["buy-2"];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain("Cancelled 1 grid order.");
  });

  it("names the saved trigger price when a sale finishes at a later start", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss", triggerPrice: "0.00145" };
    internals._getCurrentPrice = vi.fn(async () => new Decimal("0.0013"));

    // when
    await internals._liquidate("stop-loss");

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered at $0.00145, sale finished after a restart.",
    );
  });

  it("does not say finished when a resumed sale is still incomplete", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss", triggerPrice: "92" };
    state.levels[0].buyOrderIds = ["buy-1"];
    internals._getCurrentPrice = vi.fn(async () => new Decimal("88"));
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

    // when
    await throughTheWait(() => internals._liquidate("stop-loss"));

    // then
    const message = sellOffMessage(internals);
    expect(message).toContain(
      "STOP LOSS triggered at $92.00, price now $88.00.",
    );
    expect(message).not.toContain("sale finished");
  });

  it("shows the price from the end of the wait", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss", triggerPrice: "92" };
    state.levels[0].buyOrderIds = ["buy-1"];
    internals._getCurrentPrice = vi
      .fn()
      .mockResolvedValueOnce(new Decimal("88"))
      .mockResolvedValue(new Decimal("85"));
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));

    // when
    await throughTheWait(() => internals._liquidate("stop-loss"));

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered at $92.00, price now $85.00.",
    );
  });

  it("treats a malformed saved trigger price like a missing one", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss", triggerPrice: "abc" };
    internals._getCurrentPrice = vi.fn(async () => new Decimal("0.0013"));

    // when
    await internals._liquidate("stop-loss");

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered, sale finished after a restart.",
    );
  });

  it("never saves the grid's creation price as the trigger", async () => {
    // given
    const { state, internals } = liquidationBot();
    internals._currentPrice = null;
    internals._getCurrentPrice = vi.fn(async () => {
      throw new Error("ticker down");
    });
    internals._cancelUntilClosed = vi.fn(async () => ({ closed: false }));
    state.levels[0].buyOrderIds = ["buy-1"];

    // when
    await throughTheWait(() => internals._liquidate("rejected-orders"));

    // then
    expect(state.halt).toEqual({ reason: "rejected-orders" });
  });

  it("counts an order that partly filled before its cancel", async () => {
    // given
    const { state, internals } = liquidationBot({
      orders: {
        "buy-1": {
          status: "partially_filled",
          filled_quantity: "0.05",
          filled_amount: "5",
          average_fill_price: "100",
        },
      },
      sales: [{ filled_quantity: "0.05", filled_amount: "4.5" }],
    });
    state.levels[0].buyOrderIds = ["buy-1"];
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain("Cancelled 1 grid order.");
  });

  it("names no trigger price when an older save has none", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.halt = { reason: "stop-loss" };
    internals._getCurrentPrice = vi.fn(async () => new Decimal("0.0013"));

    // when
    await internals._liquidate("stop-loss");

    // then
    expect(sellOffMessage(internals)).toContain(
      "STOP LOSS triggered, sale finished after a restart.",
    );
  });

  it("says how many grid orders a dry-run sell-off cancelled", async () => {
    // given
    const { state, internals } = liquidationBot();
    state.config.dryRun = true;
    state.levels[0].buyOrderIds = ["dry-buy-a"];
    state.levels[1].buyOrderIds = ["dry-buy-b"];

    // when
    await internals._liquidate("stop-loss", new Decimal("90"));

    // then
    expect(sellOffMessage(internals)).toContain("Cancelled 2 grid orders.");
  });

  it("says a pending order found cancelled was placed anew, not sent again", async () => {
    // given
    const { state, internals, placeOrder, output } = liquidationBot({
      historical: [
        exchangeOrder("old-buy", {
          client_order_id: "lost",
          status: "cancelled",
        }),
      ],
    });
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "10" };
    placeOrder.mockImplementationOnce(async (request: SaleRequest) => ({
      data: {
        venue_order_id: "new-buy",
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    }));

    // when
    await internals._reconcileAndInit(state);

    // then
    const printed = stripVTControlCharacters(output.join(""));
    expect(printed).toContain(
      "1 pending order was cancelled on the exchange, a new one was placed",
    );
    expect(printed).not.toContain("sent again");
  });

  it("says a saved order replaced outside the bot at start-up and at the stop", async () => {
    // given
    const { bot, state, internals, output } = liquidationBot({
      orders: { "buy-x": { status: "cancelled", reject_reason: "replaced" } },
    });
    state.levels[0].buyOrderIds = ["buy-x"];
    state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };

    // when
    await internals._reconcileAndInit(state);
    await bot.shutdown();

    // then
    const printed = stripVTControlCharacters(output.join(""));
    expect(printed).toContain(
      "1 order was replaced outside the bot. The replacement isn't tracked: revx order open",
    );
    expect(printed).not.toContain("expired/cancelled on exchange");
    expect(printed).toContain(
      "1 order was replaced outside the bot. The replacement isn't tracked and wasn't cancelled. Check revx order open.",
    );
  });

  it("names an order replaced outside the bot at Ctrl+C instead of a clean exit", async () => {
    // given
    const { bot, state, internals, output } = liquidationBot({
      orders: { "buy-x": { reject_reason: "replaced" } },
    });
    state.levels[0].buyOrderIds = ["buy-x"];
    state.levels[0].buyOrderQuoteSizes = { "buy-x": "10" };
    (internals as unknown as { _lifecycle: string })._lifecycle = "running";

    // when
    await bot.shutdown();

    // then
    const printed = stripVTControlCharacters(output.join(""));
    expect(printed).not.toContain("Clean exit");
    expect(printed).toContain(
      "1 order was replaced outside the bot. The replacement isn't tracked and wasn't cancelled. Check revx order open.",
    );
  });

  it("reports an unconfirmed order sent again at start-up apart from kept ones", async () => {
    // given
    const { state, internals, placeOrder, output } = liquidationBot();
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "10" };
    placeOrder.mockImplementationOnce(async (request: SaleRequest) => ({
      data: {
        venue_order_id: "resent-buy",
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    }));

    // when
    await internals._reconcileAndInit(state);

    // then
    const printed = output.join("");
    expect(printed).toContain("1 pending order sent again");
    expect(printed).not.toContain("kept from previous session");
  });

  it("finishes the sale in flight after Ctrl+C and starts no new one", async () => {
    // given
    const { bot, state, internals, placeOrder, output } = liquidationBot();
    state.levels[1].positions = [position("p1", "0.1", "10")];
    let releaseSale!: (order: OrderDetails) => void;
    internals._awaitTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OrderDetails>((resolve) => {
            releaseSale = resolve;
          }),
      )
      .mockImplementation(async (id: string) =>
        exchangeOrder(id, {
          side: "sell",
          type: "market",
          status: "cancelled",
          filled_quantity: "0",
        }),
      );
    const liquidation = internals._liquidate("stop-loss", new Decimal("90"));
    await vi.waitFor(() => expect(internals._awaitTerminal).toHaveBeenCalled());
    let shutdownFinished = false;
    const shutdown = bot.shutdown().then(() => {
      shutdownFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishedBeforeTheSale = shutdownFinished;

    // when
    releaseSale(
      exchangeOrder("sale-1", {
        side: "sell",
        type: "market",
        status: "cancelled",
        filled_quantity: "0.04",
        filled_amount: "3.6",
      }),
    );
    await liquidation;
    await shutdown;

    // then
    expect(finishedBeforeTheSale).toBe(false);
    expect(marketSells(placeOrder)).toHaveLength(1);
    expect(state.stats.totalSells).toBe(1);
    expect(state.levels[1].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.06" }),
    ]);
    expect(state.halt).toBeDefined();
    expect(deleteGridState).not.toHaveBeenCalled();
    expect(output.join("")).toContain(
      "The sale will finish on the next start.",
    );
    expect(output.join("")).toContain(
      "Stopped by Ctrl+C before the next sale.",
    );
  });
});

describe("grid bot fee accounting", () => {
  const GROSS_BASE = "0.00635024";
  const NET_BASE = "0.00634452";
  const BUY_QUOTE = "500.00";
  const BASE_FEE = "0.00000572";
  const BUY_PRICE = new Decimal("78737.18");

  function baseFeeBuy(): OrderDetails {
    return {
      id: "buy-1",
      status: "filled",
      filled_quantity: GROSS_BASE,
      filled_amount: BUY_QUOTE,
      total_fee: BASE_FEE,
      fee_currency: "BTC",
    } as unknown as OrderDetails;
  }

  function internalsFor(state: GridState) {
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _settleTerminalBuyFill: (
        level: GridLevelState,
        order: OrderDetails,
        fallbackPrice: Decimal,
      ) => { position: GridLevelPosition | null; remainingQuote: Decimal };
      _settlePositionFill: (
        level: GridLevelState,
        position: GridLevelPosition,
        order: OrderDetails,
        fallbackPrice: Decimal,
      ) => { profit: Decimal; feeQuote: Decimal; costBasis: Decimal };
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    return internals;
  }

  it("does not add a base-denominated buy fee to the cost basis", async () => {
    // given
    const state = makeState();
    const level = state.levels[0];
    level.buyOrderIds = ["buy-1"];
    const internals = internalsFor(state);

    // when
    const { position } = internals._settleTerminalBuyFill(
      level,
      baseFeeBuy(),
      BUY_PRICE,
    );

    // then
    expect(position?.baseHeld).toBe(NET_BASE);
    expect(new Decimal(position!.fillCost!).toString()).toBe("500");
    expect(new Decimal(state.stats.totalFees!).toFixed(2)).toBe("0.45");
  });

  it("adds a quote-denominated buy fee to the cost basis", async () => {
    // given
    const state = makeState();
    const level = state.levels[0];
    level.buyOrderIds = ["buy-1"];
    const internals = internalsFor(state);

    // when
    const { position } = internals._settleTerminalBuyFill(
      level,
      {
        id: "buy-1",
        status: "filled",
        filled_quantity: GROSS_BASE,
        filled_amount: BUY_QUOTE,
        total_fee: "0.45",
        fee_currency: "USD",
      } as unknown as OrderDetails,
      BUY_PRICE,
    );

    // then
    expect(position?.baseHeld).toBe(GROSS_BASE);
    expect(new Decimal(position!.fillCost!).toString()).toBe("500.45");
    expect(new Decimal(state.stats.totalFees!).toFixed(2)).toBe("0.45");
  });

  it("realises a profit on a round trip that clears the effective entry price", async () => {
    // given
    const state = makeState();
    const level = state.levels[0];
    level.buyOrderIds = ["buy-1"];
    const internals = internalsFor(state);
    const { position } = internals._settleTerminalBuyFill(
      level,
      baseFeeBuy(),
      BUY_PRICE,
    );

    // when
    const settlement = internals._settlePositionFill(
      level,
      position!,
      {
        id: "sell-1",
        status: "filled",
        filled_quantity: NET_BASE,
        filled_amount: "500.29",
        total_fee: "0",
        fee_currency: "USD",
      } as unknown as OrderDetails,
      new Decimal("78854.46"),
    );

    // then
    expect(settlement.profit.toFixed(2)).toBe("0.29");
    expect(settlement.feeQuote.isZero()).toBe(true);
  });

  it("charges the split market buy fee once, against the base received", async () => {
    // given
    const state = makeState();
    state.config.splitInvestment = true;
    const placeOrder = vi.fn(async () => ({
      data: { venue_order_id: "split-1" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "filled",
        filled_quantity: GROSS_BASE,
        filled_amount: BUY_QUOTE,
        total_fee: BASE_FEE,
        fee_currency: "BTC",
      },
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "1000",
      splitInvestment: true,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: {
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        placeOrder: typeof placeOrder;
      };
      _executeSplitMarketBuy: (
        totalQuote: Decimal,
      ) => Promise<{ base: Decimal; cost: Decimal; fee: Decimal }>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    const result = await internals._executeSplitMarketBuy(new Decimal("500"));

    // then
    expect(result.base.toString()).toBe(NET_BASE);
    expect(result.cost.toString()).toBe("500");
    expect(result.fee.toFixed(2)).toBe("0.45");
  });
});

describe("grid bot order rejection", () => {
  type PlacementRequest = {
    clientOrderId: string;
    limit: {
      price?: string;
      quoteSize?: string;
      baseSize?: string;
      executionInstructions?: string[];
    };
  };

  function rejectedOrder(overrides: Partial<OrderDetails> = {}): OrderDetails {
    return {
      id: "rejected-order",
      client_order_id: "client-order",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      quantity: "0",
      filled_quantity: "0",
      filled_amount: "0",
      leaves_quantity: "0",
      amount: "10",
      price: "99",
      status: "rejected",
      reject_reason: "POST_ONLY_IMMEDIATE_MATCH",
      time_in_force: "gtc",
      execution_instructions: ["post_only"],
      created_date: 1,
      updated_date: 1,
      ...overrides,
    };
  }

  function rejectedPlacement(request: PlacementRequest) {
    return {
      data: {
        venue_order_id: `venue-${request.clientOrderId}`,
        client_order_id: request.clientOrderId,
        state: "rejected" as const,
      },
    };
  }

  function acceptedPlacement(request: PlacementRequest, venueOrderId: string) {
    return {
      data: {
        venue_order_id: venueOrderId,
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    };
  }

  function settledRejection() {
    return vi.fn(async (id: string) => ({
      data: rejectedOrder({
        id,
        client_order_id: id.replace(/^venue-/, ""),
        reject_reason: "self_matching_protection",
        execution_instructions: ["allow_taker"],
      }),
    }));
  }

  function placementInternals(
    state: GridState,
    placeOrder: ReturnType<typeof vi.fn>,
  ) {
    const getOrder = settledRejection();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
      };
      _placeBuyOrder: (
        level: GridLevelState,
        quoteSize: Decimal,
        clientOrderId: string,
      ) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder, getOrder };
    return { internals, getOrder };
  }

  function sentRequests(placeOrder: ReturnType<typeof vi.fn>) {
    return placeOrder.mock.calls.map(
      ([request]) => request as PlacementRequest,
    );
  }

  it("sends grid buys and sells as plain limit orders that may fill at once", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "position-1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
    };
    state.levels[0].positions = [position];
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      acceptedPlacement(request, `order-${request.clientOrderId}`),
    );
    const { internals } = placementInternals(state, placeOrder);

    // when
    await internals._placeBuyOrder(
      state.levels[0],
      new Decimal("10"),
      "client-order",
    );
    await internals._placeSellOnLevel(state.levels[1], position);

    // then
    expect(
      sentRequests(placeOrder).map(
        (request) => request.limit.executionInstructions,
      ),
    ).toEqual([["allow_taker"], ["allow_taker"]]);
  });

  it("logs a buy that filled below its level at the price it actually got", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _processTerminalBuy: (
        level: GridLevelState,
        order: OrderDetails,
        notify: boolean,
        replaceOrders: boolean,
      ) => Promise<boolean>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;

    // when
    await internals._processTerminalBuy(
      state.levels[0],
      rejectedOrder({
        id: "buy-1",
        status: "filled",
        filled_quantity: "0.105",
        filled_amount: "10",
        average_fill_price: "95.2",
      }),
      false,
      false,
    );

    // then
    expect(state.tradeLog.at(-1)).toEqual(
      expect.objectContaining({ side: "buy", price: "95.2" }),
    );
  });

  it("keeps a rejected buy's client order ID and sends nothing more at once", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      rejectedPlacement(request),
    );
    const { internals, getOrder } = placementInternals(state, placeOrder);

    // when
    const orderId = await internals._placeBuyOrder(
      state.levels[0],
      new Decimal("10"),
      "client-order",
    );

    // then
    expect(orderId).toBeNull();
    expect(sentRequests(placeOrder).map((r) => r.clientOrderId)).toEqual([
      "client-order",
    ]);
    expect(getOrder).not.toHaveBeenCalled();
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["client-order"]);
    expect(state.levels[0].pendingBuyQuoteSizes).toEqual({
      "client-order": "10",
    });
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(internals._warnings).toEqual([]);
  });

  it("treats an error thrown by order placement as a failure, not a rejection", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const placeOrder = vi.fn(async () => {
      throw new Error("Order rejected: POST_ONLY_IMMEDIATE_MATCH");
    });
    const { internals } = placementInternals(state, placeOrder);

    // when
    const placement = internals._placeBuyOrder(
      state.levels[0],
      new Decimal("10"),
      "client-order",
    );

    // then
    await expect(placement).rejects.toThrow("POST_ONLY_IMMEDIATE_MATCH");
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["client-order"]);
  });

  it("keeps a rejected sell's client order ID and sends nothing more until it is looked up", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "position-1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
    };
    state.levels[0].positions = [position];
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      rejectedPlacement(request),
    );
    const { internals, getOrder } = placementInternals(state, placeOrder);

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    await internals._placeSellOnLevel(state.levels[1], position);

    // then
    const requests = sentRequests(placeOrder);
    expect(requests).toHaveLength(1);
    expect(getOrder).not.toHaveBeenCalled();
    expect(position.sellOrderId).toBeNull();
    expect(position.sellClientOrderId).toBe(requests[0].clientOrderId);
    expect(position.sellBaseSize).toBe("0.1");
    expect(internals._warnings).toEqual([]);
  });

  it("keeps a rejected partial buy remainder pending under its client order ID", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      rejectedPlacement(request),
    );
    const getOrder = settledRejection();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
      };
      _placeSellOnLevel: ReturnType<typeof vi.fn>;
      _processTerminalBuy: (
        level: GridLevelState,
        order: OrderDetails,
        notify: boolean,
      ) => Promise<boolean>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder, getOrder };
    internals._placeSellOnLevel = vi.fn(async () => undefined);

    // when
    const settlement = internals._processTerminalBuy(
      state.levels[0],
      {
        id: "buy-1",
        status: "partially_filled",
        filled_quantity: "0.04",
        filled_amount: "4",
        total_fee: "0",
        fee_currency: "USD",
      },
      false,
    );

    // then
    await expect(settlement).resolves.toBe(true);
    const sent = sentRequests(placeOrder);
    expect(sent.map((request) => request.limit.quoteSize)).toEqual(["6"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([
      sent[0].clientOrderId,
    ]);
  });

  it("keeps a rejected re-buy after a completed sell pending under its client order ID", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "position-1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: "sell-1",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      rejectedPlacement(request),
    );
    const getOrder = settledRejection();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
      };
      _processTerminalSell: (
        level: GridLevelState,
        sellLevel: GridLevelState,
        position: GridLevelPosition,
        order: OrderDetails,
        notify: boolean,
      ) => Promise<unknown>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder, getOrder };

    // when
    const settlement = internals._processTerminalSell(
      state.levels[0],
      state.levels[1],
      position,
      {
        id: "sell-1",
        status: "filled",
        filled_quantity: "0.1",
        filled_amount: "11",
        total_fee: "0",
        fee_currency: "USD",
      },
      false,
    );

    // then
    await expect(settlement).resolves.toBeDefined();
    const sent = sentRequests(placeOrder);
    expect(sent).toHaveLength(1);
    expect(state.stats.realizedPnl).toBe("1");
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([
      sent[0].clientOrderId,
    ]);
  });

  it("holds a legacy post-only order found rejected under its client order ID instead of placing another at once", async () => {
    // given
    const state = makeState();
    const order = rejectedOrder({ id: "buy-1" });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getOrder = vi.fn(async () => ({ data: order }));
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      acceptedPlacement(request, `order-${request.clientOrderId}`),
    );
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      getActiveOrders,
      getHistoricalOrders: vi.fn(async () => ({ data: [], metadata: {} })),
      getOrder,
      placeOrder,
      getBalances,
    };

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["client-order"]);
    expect(state.levels[0].pendingBuyQuoteSizes).toEqual({
      "client-order": "10",
    });
    expect(
      sentRequests(placeOrder).filter(
        (request) => request.limit.price === "99",
      ),
    ).toEqual([]);
    expect(internals._warnings.filter((w) => w.includes("rejected"))).toEqual(
      [],
    );
  });

  it("books the fill of an already tracked buy that was rejected and keeps running", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    const order = rejectedOrder({
      id: "buy-1",
      filled_quantity: "0.1",
      filled_amount: undefined,
      average_fill_price: "98",
    });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getOrder = vi.fn(async (id: string) => ({
      data: id === "buy-1" ? order : rejectedOrder({ id, status: "new" }),
    }));
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      acceptedPlacement(request, `order-${request.clientOrderId}`),
    );
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { getActiveOrders, getOrder, placeOrder, getBalances };

    // when
    await internals._tick(new Decimal("100"));

    // then
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.1", fillCost: "9.8" }),
    ]);
  });
});

describe("grid bot rejections counted per order slot", () => {
  type Request = {
    clientOrderId: string;
    side: "buy" | "sell";
    limit: { price: string; quoteSize?: string; baseSize?: string };
  };
  type Outcome =
    | "rejected"
    | "refused"
    | "placed"
    | "unreadable"
    | { filledQuantity: string; filledAmount: string };

  function venueOrder(
    id: string,
    request: Request,
    overrides: Partial<OrderDetails> = {},
  ): OrderDetails {
    return {
      id,
      client_order_id: request.clientOrderId,
      symbol: "BTC/USD",
      side: request.side,
      type: "limit",
      quantity: request.limit.baseSize ?? "0.1",
      filled_quantity: "0",
      filled_amount: "0",
      leaves_quantity: "0",
      price: request.limit.price,
      status: "new",
      time_in_force: "gtc",
      execution_instructions: ["allow_taker"],
      total_fee: "0",
      fee_currency: "USD",
      created_date: 1,
      updated_date: 1,
      ...overrides,
    };
  }

  function trackedBuy(status: string): OrderDetails {
    return {
      id: "buy-1",
      client_order_id: "client-buy-1",
      status,
      filled_quantity: "0",
    } as OrderDetails;
  }

  function streakBot(
    state: GridState,
    outcomes: { buy?: Outcome[]; sell?: Outcome[] } = {},
    orders = new Map<string, OrderDetails>(),
    listed: Order[] = [],
  ) {
    const scripts = {
      buy: [...(outcomes.buy ?? [])],
      sell: [...(outcomes.sell ?? [])],
    };
    const active = new Map<string, string>();
    let sent = 0;
    const placeOrder = vi.fn(async (request: Request) => {
      sent++;
      const id = `venue-${sent}`;
      const outcome = scripts[request.side].shift() ?? "placed";
      if (outcome === "refused") {
        throw new Error("Insufficient balance of 0 BTC");
      }
      if (outcome === "placed") {
        orders.set(id, venueOrder(id, request));
        return {
          data: {
            venue_order_id: id,
            client_order_id: request.clientOrderId,
            state: "new" as const,
          },
        };
      }
      if (outcome !== "unreadable") {
        orders.set(
          id,
          venueOrder(id, request, {
            status: "rejected",
            reject_reason: "self_matching_protection",
            ...(outcome === "rejected"
              ? {}
              : {
                  filled_quantity: outcome.filledQuantity,
                  filled_amount: outcome.filledAmount,
                }),
          }),
        );
      }
      return {
        data: {
          venue_order_id: id,
          client_order_id: request.clientOrderId,
          state: "rejected" as const,
        },
      };
    });
    const getOrder = vi.fn(async (id: string) => {
      const order = orders.get(id);
      if (!order) throw new NotFoundError(`Order with ID '${id}' not found.`);
      return { data: order };
    });
    const getActiveOrders = vi.fn(async () => ({
      data: [...active].map(([id, status]) => ({
        id,
        client_order_id: orders.get(id)?.client_order_id ?? id,
        status,
      })),
      metadata: {},
    }));
    const closed = () =>
      [...orders.values()].filter(
        (order) => !["new", "partially_filled"].includes(order.status),
      ) as unknown as Order[];
    const getHistoricalOrders = vi.fn(
      async (request: { startDate: number; endDate: number }) => ({
        data:
          request.startDate <= request.endDate ? [...listed, ...closed()] : [],
        metadata: {},
      }),
    );
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _client: Record<string, unknown>;
      _priceSource: { peek: () => Promise<Decimal> };
      _notify: ReturnType<typeof vi.fn>;
      _flushPlacementAlerts: () => void;
      _tick: (price: Decimal) => Promise<void>;
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
      _resumePendingPlacements: () => Promise<Set<string>>;
      _resumePendingSell: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
        order: Order | undefined,
        resend: boolean,
      ) => Promise<string | null>;
      _placeBuyOrder: (
        level: GridLevelState,
        quoteSize: Decimal,
        clientOrderId?: string,
      ) => Promise<string | null>;
      _placeBuyOrAlert: (
        level: GridLevelState,
        quoteSize: Decimal,
        clientOrderId?: string,
      ) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
      getBalances,
    };
    internals._priceSource = { peek: async () => new Decimal("99.5") };
    const notify = vi.fn();
    internals._notify = notify;
    return { bot, internals, placeOrder, getOrder, orders, active, notify };
  }

  function heldPosition(): GridLevelPosition {
    return {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "10",
      slotQuote: "10",
      sellOrderId: null,
    };
  }

  function sells(placeOrder: ReturnType<typeof vi.fn>): Request[] {
    return placeOrder.mock.calls
      .map(([request]) => request as Request)
      .filter((request) => request.side === "sell");
  }

  function rejectLater(orders: Map<string, OrderDetails>, id: string): void {
    orders.set(id, { ...orders.get(id)!, status: "rejected" });
  }

  function rejectionWarnings(warnings: string[]): string[] {
    return warnings.filter((warning) => warning.includes("rejected, retrying"));
  }

  function minuteChecks(internals: {
    _warnings: string[];
    _tick: (price: Decimal) => Promise<void>;
  }) {
    const warnings: string[] = [];
    const check = async () => {
      await internals._tick(new Decimal("99.5"));
      warnings.push(...rejectionWarnings(internals._warnings));
    };
    const fiveMinutes = async () => {
      for (let minute = 0; minute < 5; minute++) {
        vi.setSystemTime(Date.now() + 61_000);
        await check();
      }
    };
    return { warnings, check, fiveMinutes };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps counting when the exchange accepts each new buy and rejects it later", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const orders = new Map([["buy-1", trackedBuy("rejected")]]);
    const { internals } = streakBot(state, {}, orders);
    let failure: unknown = null;

    // when
    for (let minute = 0; minute < 20 && !failure; minute++) {
      for (const id of state.levels[0].buyOrderIds) rejectLater(orders, id);
      await internals._tick(new Decimal("99.5")).catch((err: unknown) => {
        failure = err;
      });
      vi.setSystemTime(Date.now() + 61_000);
    }

    // then
    expect(failure).toMatchObject({
      name: "OrderRejectedError",
      side: "buy",
      price: "99",
    });
  });

  it("starts the count again once a new order is seen on the book", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const orders = new Map([["buy-1", trackedBuy("rejected")]]);
    const { internals, active } = streakBot(state, {}, orders);
    const { warnings, check, fiveMinutes } = minuteChecks(internals);
    await check();
    await fiveMinutes();
    const replacement = state.levels[0].buyOrderIds[0];
    active.set(replacement, "new");
    await check();
    active.delete(replacement);
    rejectLater(orders, replacement);

    // when
    await check();
    await fiveMinutes();

    // then
    expect(warnings).toEqual([
      "Buy @99 rejected, retrying (2/3)",
      "Buy @99 rejected, retrying (2/3)",
    ]);
  });

  it("does not take an order the exchange still lists as pending as proof", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const orders = new Map([["buy-1", trackedBuy("rejected")]]);
    const { internals, active } = streakBot(state, {}, orders);
    const { warnings, check, fiveMinutes } = minuteChecks(internals);
    await check();
    await fiveMinutes();
    const replacement = state.levels[0].buyOrderIds[0];
    active.set(replacement, "pending_new");
    await check();
    active.delete(replacement);
    rejectLater(orders, replacement);

    // when
    await check();
    await fiveMinutes();

    // then
    expect(warnings).toEqual([
      "Buy @99 rejected, retrying (2/3)",
      "Buy @99 rejected, retrying (3/3)",
    ]);
  });

  it("books a rejected order that traded, found by the minute lookup, without counting a rejection", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "10" };
    const traded = {
      id: "lost-order",
      client_order_id: "lost",
      status: "rejected",
      filled_quantity: "0.05",
      filled_amount: "4.95",
      total_fee: "0",
      fee_currency: "USD",
    } as OrderDetails;
    const { internals } = streakBot(
      state,
      {},
      new Map([["lost-order", traded]]),
      [traded as unknown as Order],
    );
    await internals._tick(new Decimal("99.5"));
    const firstCheck = rejectionWarnings(internals._warnings);

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(firstCheck).toEqual([]);
    expect(rejectionWarnings(internals._warnings)).toEqual([]);
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.05" }),
    ]);
  });

  it("holds a sell found rejected when resuming it, without counting it or sending another", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position = {
      ...heldPosition(),
      sellClientOrderId: "lost-sell",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];
    const { internals, placeOrder } = streakBot(state, {}, new Map(), [
      {
        id: "lost-sell-order",
        client_order_id: "lost-sell",
        status: "rejected",
        filled_quantity: "0",
      } as Order,
    ]);

    // when
    await internals._resumePendingPlacements();

    // then
    expect(rejectionWarnings(internals._warnings)).toEqual([]);
    expect(sells(placeOrder)).toEqual([]);
    expect(position.sellOrderId).toBeNull();
    expect(position.sellClientOrderId).toBe("lost-sell");
  });

  it("holds a tracked buy found rejected at start-up under its client order ID, without counting it", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    const { internals } = streakBot(
      state,
      {},
      new Map([["buy-1", trackedBuy("rejected")]]),
    );

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(rejectionWarnings(internals._warnings)).toEqual([]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["client-buy-1"]);
  });

  it("books what a rejected sell traded and sends only the rest", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position = heldPosition();
    state.levels[0].positions = [position];
    const { internals, placeOrder } = streakBot(state, {
      sell: [{ filledQuantity: "0.04", filledAmount: "3.964" }, "placed"],
    });

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    await internals._tick(new Decimal("99.5"));
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells(placeOrder).map((request) => request.limit.baseSize)).toEqual([
      "0.1",
      "0.06",
    ]);
    expect(position.baseHeld).toBe("0.06");
    expect(state.stats.totalSells).toBe(1);
    expect(state.stats.realizedPnl).toBe("-0.036");
  });

  it("keeps what a rejected buy traded as a position and sells it", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const { internals, placeOrder } = streakBot(state, {
      buy: [{ filledQuantity: "0.05", filledAmount: "4.95" }],
    });

    // when
    const result = await internals._placeBuyOrder(
      state.levels[0],
      new Decimal("10"),
      "first",
    );
    await internals._tick(new Decimal("99.5"));
    await internals._tick(new Decimal("99.5"));

    // then
    expect(result).toBeNull();
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({ baseHeld: "0.05", fillCost: "4.95" }),
    ]);
    expect(sells(placeOrder).map((request) => request.limit.baseSize)).toEqual([
      "0.05",
    ]);
  });

  it("keeps an order reported rejected that turns out to rest on the book", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position = heldPosition();
    state.levels[0].positions = [position];
    const { internals, active, placeOrder } = streakBot(state, {
      sell: ["rejected"],
    });
    await internals._placeSellOnLevel(state.levels[1], position);
    active.set("venue-1", "new");

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(position.sellOrderId).toBe("venue-1");
    expect(sells(placeOrder)).toHaveLength(1);
  });

  it("keeps a re-sent buy that comes back rejected pending through start-up", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["stale"];
    state.levels[0].pendingBuyQuoteSizes = { stale: "10" };
    const { internals, placeOrder } = streakBot(state, { buy: ["rejected"] });

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(
      placeOrder.mock.calls.map(([request]) => request.clientOrderId),
    ).toEqual(["stale"]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale"]);
  });

  it("alerts again after an order of the slot is found on the exchange", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    const position = heldPosition();
    state.levels[0].positions = [position];
    const { internals, notify } = streakBot(state, {
      sell: ["refused", "refused"],
    });
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();
    await internals._resumePendingSell(
      state.levels[1],
      position,
      {
        id: "found",
        client_order_id: position.sellClientOrderId!,
        status: "new",
        filled_quantity: "0",
      } as Order,
      true,
    );
    position.sellOrderId = null;
    position.sellClientOrderId = undefined;
    position.sellBaseSize = undefined;

    // when
    await internals._placeSellOnLevel(state.levels[1], position);
    internals._flushPlacementAlerts();

    // then
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not send a rejected order again while a sell-off is running", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.halt = { reason: "stop-loss" };
    const position = heldPosition();
    state.levels[0].positions = [position];
    const { internals, placeOrder } = streakBot(state, {
      sell: ["rejected", "rejected", "rejected", "rejected"],
    });

    // when
    await internals._placeSellOnLevel(state.levels[1], position);

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("starts every count again after trailing up rebuilds the grid", async () => {
    // given
    const state = makeState();
    state.config.dryRun = true;
    state.quotePrecision = "0.01";
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: true,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _placementHealth: {
        rejected: (slot: string, clientOrderId: string) => number | null;
      };
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._placementHealth.rejected("buy:0", "earlier-1");
    internals._placementHealth.rejected("buy:0", "earlier-2");

    // when
    await internals._rebuildGridUp(new Decimal("110"));

    // then
    expect(internals._placementHealth.rejected("buy:0", "after")).toBe(1);
  });
});

describe("grid bot pending placement recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type PlacementRequest = {
    clientOrderId: string;
    side: "buy" | "sell";
    limit: { price?: string; quoteSize?: string; baseSize?: string };
  };

  function exchangeOrder(overrides: Partial<Order>): Order {
    return {
      id: "exchange-order",
      client_order_id: "stale-client",
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      quantity: "0.101",
      filled_quantity: "0",
      leaves_quantity: "0.101",
      price: "99",
      status: "rejected",
      time_in_force: "gtc",
      execution_instructions: ["post_only"],
      created_date: 1,
      updated_date: 1,
      ...overrides,
    };
  }

  function duplicateClientOrderId(request: PlacementRequest): never {
    throw new BadRequestError(
      `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
    );
  }

  function recoveryInternals(
    exchange: {
      active?: Order[];
      historical?: Order[];
      price?: string;
      available?: string;
      placeOrder?: (request: PlacementRequest) => unknown;
    } = {},
  ) {
    const state = makeState();
    state.createdAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["stale-client"];
    state.levels[0].pendingBuyQuoteSizes = { "stale-client": "10" };
    const placeOrder = vi.fn(async (request: PlacementRequest) =>
      (exchange.placeOrder ?? duplicateClientOrderId)(request),
    );
    const getActiveOrders = vi.fn(async () => ({
      data: exchange.active ?? [],
      metadata: {},
    }));
    const getHistoricalOrders = vi.fn(
      async (options: { startDate: number; endDate: number }) => ({
        data:
          options.startDate <= options.endDate
            ? (exchange.historical ?? [])
            : [],
        metadata: {},
      }),
    );
    const getBalances = vi.fn(async () => [
      { currency: "USD", available: exchange.available ?? "1000" },
    ]);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _attentionLines: () => string[];
      _client: {
        placeOrder: typeof placeOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
        getBalances: typeof getBalances;
      };
      _priceSource?: { peek: () => Promise<Decimal> };
      _pendingSweepAt: number;
      _placementHealth: {
        takeAlerts: () => Array<{ order: string; reason: string }>;
      };
      _resumePendingPlacements: () => Promise<void>;
      _sweepPendingIntents: (activeOrders: Map<string, Order>) => Promise<void>;
      _placeBuyOrAlert: (
        level: GridLevelState,
        quoteSize?: Decimal,
        clientOrderId?: string,
      ) => Promise<string | null>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getActiveOrders,
      getHistoricalOrders,
      getBalances,
    };
    if (exchange.price) {
      const price = new Decimal(exchange.price);
      internals._priceSource = { peek: async () => price };
    }
    return { state, internals, placeOrder, getHistoricalOrders };
  }

  function pendingSell(state: GridState): GridLevelPosition {
    state.levels[0].pendingBuyClientOrderIds = [];
    state.levels[0].pendingBuyQuoteSizes = {};
    const position: GridLevelPosition = {
      id: "position-1",
      baseHeld: "0.1",
      fillCost: "10",
      sellOrderId: null,
      sellClientOrderId: "stale-sell",
      sellBaseSize: "0.1",
    };
    state.levels[0].positions = [position];
    return position;
  }

  it("holds a pending buy the exchange already rejected at start-up and replaces it at its amount 5 minutes later", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = recoveryInternals({
      historical: [exchangeOrder({ id: "old-rejected" })],
      placeOrder: async (request) => ({
        data: {
          venue_order_id: "fresh-buy",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });
    await internals._resumePendingPlacements();
    const atStartUp = {
      sent: placeOrder.mock.calls.length,
      pending: [...(state.levels[0].pendingBuyClientOrderIds ?? [])],
    };

    // when
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await internals._sweepPendingIntents(new Map());

    // then
    expect(atStartUp).toEqual({ sent: 0, pending: ["stale-client"] });
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).not.toBe("stale-client");
    expect(placeOrder.mock.calls[0][0].limit.quoteSize).toBe("10");
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(state.levels[0].buyOrderIds).toEqual(["fresh-buy"]);
  });

  it("keeps the new buy pending at its amount when it can't be sent after the rejected one is given up", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals } = recoveryInternals({
      historical: [exchangeOrder({ id: "old-rejected" })],
      placeOrder: async () => {
        throw new Error("socket hang up");
      },
    });
    await internals._resumePendingPlacements();

    // when
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await internals._sweepPendingIntents(new Map());

    // then
    const pending = state.levels[0].pendingBuyClientOrderIds ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).not.toBe("stale-client");
    expect(state.levels[0].pendingBuyQuoteSizes?.[pending[0]]).toBe("10");
  });

  it("adopts a pending buy that is still open on the exchange", async () => {
    // given
    const { state, internals } = recoveryInternals({
      active: [exchangeOrder({ id: "open-buy", status: "new" })],
    });

    // when
    await internals._resumePendingPlacements();

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["open-buy"]);
    expect(state.levels[0].buyOrderQuoteSizes).toEqual({ "open-buy": "10" });
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("adopts a pending buy that already filled so it gets settled", async () => {
    // given
    const { state, internals } = recoveryInternals({
      historical: [
        exchangeOrder({
          id: "filled-buy",
          status: "filled",
          filled_quantity: "0.101",
          leaves_quantity: "0",
        }),
      ],
    });

    // when
    await internals._resumePendingPlacements();

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["filled-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("re-sends a pending buy that never reached the exchange even when the price is below its level", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      price: "98",
      placeOrder: (request) => ({
        data: {
          venue_order_id: "taken-buy",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].buyOrderIds).toEqual(["taken-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("re-sends a pending buy that never reached the exchange", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      price: "100",
      placeOrder: (request) => ({
        data: {
          venue_order_id: "resent-buy",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).toBe("stale-client");
    expect(state.levels[0].buyOrderIds).toEqual(["resent-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("keeps a re-sent buy through the startup check while the exchange still reports it missing", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["stale-client"];
    state.levels[0].pendingBuyQuoteSizes = { "stale-client": "10" };
    const placeOrder = vi.fn(async (request: PlacementRequest) => ({
      data: {
        venue_order_id: "resent-buy",
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    }));
    const getOrder = vi.fn(async (orderId: string) => {
      throw new NotFoundError(`Order with ID '${orderId}' not found.`);
    });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
    };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].buyOrderIds).toEqual(["resent-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("keeps a pending buy the exchange has but cannot be found, and warns", async () => {
    // given
    const { state, internals } = recoveryInternals();

    // when
    await internals._resumePendingPlacements();

    // then
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(internals._attentionLines()).toEqual([
      "Buy @99 rejected or already placed, looked up once a minute",
    ]);
  });

  it("still starts when a pending buy that never reached the exchange can't be sent", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      placeOrder: () => {
        throw new RevolutXError(
          "Insufficient balance of 0 USD, required 10 USD",
          422,
        );
      },
    });

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).toBe("stale-client");
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(state.levels[0].pendingBuyQuoteSizes).toEqual({
      "stale-client": "10",
    });
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(internals._attentionLines()).toEqual([
      "Buy @99 not placed: Insufficient balance of 0 USD, required 10 USD",
    ]);
    expect(internals._placementHealth.takeAlerts()).toEqual([
      expect.objectContaining({
        reason: "Insufficient balance of 0 USD, required 10 USD",
      }),
    ]);
  });

  it("finishes the startup check when a pending buy that never reached the exchange can't be sent", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["stale-client"];
    state.levels[0].pendingBuyQuoteSizes = { "stale-client": "10" };
    const placeOrder = vi.fn(async (): Promise<never> => {
      throw new RevolutXError(
        "Insufficient balance of 0 USD, required 10 USD",
        422,
      );
    });
    const getOrder = vi.fn(async (orderId: string) => {
      throw new NotFoundError(`Order with ID '${orderId}' not found.`);
    });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
    };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    const startup = internals._reconcileAndInit(state);

    // then
    await expect(startup).resolves.toBeUndefined();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
  });

  it("doesn't restore a second first buy on a level whose pending buy start-up couldn't send", async () => {
    // given
    const state = makeState();
    state.initializing = true;
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["stale-client"];
    state.levels[0].pendingBuyQuoteSizes = { "stale-client": "10" };
    const placeOrder = vi.fn(async (request: PlacementRequest) => {
      if (request.clientOrderId === "stale-client") {
        throw new Error("socket hang up");
      }
      return {
        data: {
          venue_order_id: `buy-at-${request.limit.price}`,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder, getActiveOrders, getHistoricalOrders };
    internals._priceSource = { peek: async () => new Decimal("100") };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder.mock.calls.map((call) => call[0].limit.price)).toEqual([
      "99",
      "99.1",
    ]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(state.levels[1].buyOrderIds).toEqual(["buy-at-99.1"]);
    expect(state.initializing).toBe(false);
  });

  it("sends a pending buy start-up couldn't send with its own id once the minute lookup finds the cash", async () => {
    // given
    let cashLocked = true;
    const exchange = {
      available: "0",
      placeOrder: (request: PlacementRequest) => {
        if (cashLocked) {
          throw new RevolutXError(
            "Insufficient balance of 0 USD, required 10 USD",
            422,
          );
        }
        return {
          data: {
            venue_order_id: "sent-buy",
            client_order_id: request.clientOrderId,
            state: "new",
          },
        };
      },
    };
    const { state, internals, placeOrder } = recoveryInternals(exchange);
    await internals._resumePendingPlacements();
    await internals._sweepPendingIntents(new Map());
    internals._pendingSweepAt = 0;
    await internals._sweepPendingIntents(new Map());
    const sendsWhileLocked = placeOrder.mock.calls.length;
    const lineWhileLocked = internals._attentionLines();
    cashLocked = false;
    exchange.available = "1000";

    // when
    internals._pendingSweepAt = 0;
    await internals._sweepPendingIntents(new Map());

    // then
    expect(sendsWhileLocked).toBe(1);
    expect(lineWhileLocked).toEqual([
      "Buy @99 not placed: not enough USD, $0.00 free",
    ]);
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(placeOrder.mock.calls[1][0].clientOrderId).toBe("stale-client");
    expect(placeOrder.mock.calls[1][0].limit.quoteSize).toBe("10");
    expect(state.levels[0].buyOrderIds).toEqual(["sent-buy"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
  });

  it("only looks up a pending buy the exchange called already placed at start-up", async () => {
    // given
    const { state, internals, placeOrder, getHistoricalOrders } =
      recoveryInternals();
    await internals._resumePendingPlacements();
    const lookupsAtStartup = getHistoricalOrders.mock.calls.length;

    // when
    await internals._sweepPendingIntents(new Map());
    internals._pendingSweepAt = 0;
    await internals._sweepPendingIntents(new Map());

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(getHistoricalOrders.mock.calls.length).toBeGreaterThan(
      lookupsAtStartup,
    );
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(internals._attentionLines()).toEqual([
      "Buy @99 rejected or already placed, looked up once a minute",
    ]);
  });

  it("still starts when a pending sell that never reached the exchange can't be sent", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      placeOrder: () => {
        throw new RevolutXError(
          "Insufficient balance of 0 BTC, required 0.1 BTC",
          422,
        );
      },
    });
    const position = pendingSell(state);

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).toBe("stale-sell");
    expect(position.sellClientOrderId).toBe("stale-sell");
    expect(position.sellOrderId).toBeNull();
    expect(internals._attentionLines()).toEqual([
      "Sell @99.1 not placed: Insufficient balance of 0 BTC, required 0.1 BTC",
    ]);
  });

  describe("how far back an order lookup reads", () => {
    const DAY = 24 * 60 * 60 * 1000;

    afterEach(() => {
      vi.useRealTimers();
    });

    function earliestStart(getHistoricalOrders: {
      mock: { calls: Array<[{ startDate: number }]> };
    }): number {
      return Math.min(
        ...getHistoricalOrders.mock.calls.map((call) => call[0].startDate),
      );
    }

    it("reads a buy whose send failed only from a day before it was sent", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: () => {
          throw new Error("socket hang up");
        },
      });
      state.levels[0].pendingBuyClientOrderIds = [];
      state.levels[0].pendingBuyQuoteSizes = {};
      const sentAt = Date.now();
      await internals._placeBuyOrAlert(state.levels[0], new Decimal("10"));
      vi.setSystemTime(sentAt + 30_000);

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(getHistoricalOrders).toHaveBeenCalled();
      expect(earliestStart(getHistoricalOrders)).toBe(sentAt - DAY);
    });

    it("reads a sell refused as already placed only from a day before it was sent", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const sentAt = Date.now();
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: (request) => {
          vi.setSystemTime(sentAt + 60 * 60 * 1000);
          throw new BadRequestError(
            `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
          );
        },
      });
      const position = pendingSell(state);
      position.sellClientOrderId = undefined;
      await internals._placeSellOnLevel(state.levels[1], position);

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(getHistoricalOrders).toHaveBeenCalled();
      expect(earliestStart(getHistoricalOrders)).toBe(sentAt - DAY);
    });

    it("reads a sell that came back rejected only from a day before it was sent", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const sentAt = Date.now();
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: (request) => {
          vi.setSystemTime(sentAt + 60 * 60 * 1000);
          return {
            data: {
              venue_order_id: "rejected-copy",
              client_order_id: request.clientOrderId,
              state: "rejected",
            },
          };
        },
      });
      const position = pendingSell(state);
      position.sellClientOrderId = undefined;
      await internals._placeSellOnLevel(state.levels[1], position);

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(getHistoricalOrders).toHaveBeenCalled();
      expect(earliestStart(getHistoricalOrders)).toBe(sentAt - DAY);
    });

    it("keeps a sell's client id when the retry after a server error failed differently", async () => {
      // given
      const { state, internals } = recoveryInternals({
        placeOrder: () => {
          throw new ServerError("Service unavailable", 503, {
            cause: new BadRequestError("Insufficient balance"),
          });
        },
      });
      const position = pendingSell(state);
      position.sellClientOrderId = undefined;

      // when
      await internals._placeSellOnLevel(state.levels[1], position);

      // then
      expect(position.sellClientOrderId).toEqual(expect.any(String));
      expect(position.sellOrderId).toBeNull();
    });

    it("looks up a sell whose resend after a server error is refused as already placed", async () => {
      // given
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: (request) => {
          throw new BadRequestError(
            `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
            { cause: new ServerError("Service unavailable", 503) },
          );
        },
      });
      const position = pendingSell(state);
      position.sellClientOrderId = undefined;
      await internals._placeSellOnLevel(state.levels[1], position);

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(getHistoricalOrders).toHaveBeenCalled();
      expect(position.sellClientOrderId).toEqual(expect.any(String));
    });

    it("keeps the first send time when the same buy fails to go out again", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: () => {
          throw new Error("socket hang up");
        },
      });
      state.levels[0].pendingBuyClientOrderIds = [];
      state.levels[0].pendingBuyQuoteSizes = {};
      const firstSentAt = Date.now();
      await internals._placeBuyOrAlert(state.levels[0], new Decimal("10"));
      const clientOrderId = state.levels[0].pendingBuyClientOrderIds[0];
      vi.setSystemTime(firstSentAt + 2 * DAY);
      await internals._placeBuyOrAlert(
        state.levels[0],
        new Decimal("10"),
        clientOrderId,
      );

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(earliestStart(getHistoricalOrders)).toBe(firstSentAt - DAY);
    });

    it("reads from the older of two buys whose sends failed", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: () => {
          throw new Error("socket hang up");
        },
      });
      state.levels[0].pendingBuyClientOrderIds = [];
      state.levels[0].pendingBuyQuoteSizes = {};
      const olderSentAt = Date.now();
      await internals._placeBuyOrAlert(state.levels[0], new Decimal("10"));
      vi.setSystemTime(olderSentAt + 6 * 60 * 60 * 1000);
      await internals._placeBuyOrAlert(state.levels[1], new Decimal("10"));

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(earliestStart(getHistoricalOrders)).toBe(olderSentAt - DAY);
    });

    it("reads the grid's whole history when one of the buys has no known send time", async () => {
      // given
      vi.useFakeTimers({ toFake: ["Date"] });
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: () => {
          throw new Error("socket hang up");
        },
      });
      await internals._placeBuyOrAlert(state.levels[1], new Decimal("10"));

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(state.levels[0].pendingBuyClientOrderIds).toEqual([
        "stale-client",
      ]);
      expect(earliestStart(getHistoricalOrders)).toBe(
        Date.parse(state.createdAt) - DAY,
      );
    });

    it("still reads the grid's whole history for a pending buy with no known send time", async () => {
      // given
      const { state, internals, getHistoricalOrders } = recoveryInternals();

      // when
      await internals._sweepPendingIntents(new Map());

      // then
      expect(earliestStart(getHistoricalOrders)).toBe(
        Date.parse(state.createdAt) - DAY,
      );
    });

    it("reads the grid's whole history at start-up, even with a send time on record", async () => {
      // given
      const { state, internals, getHistoricalOrders } = recoveryInternals({
        placeOrder: () => {
          throw new Error("socket hang up");
        },
      });
      await internals._placeBuyOrAlert(state.levels[1], new Decimal("10"));
      getHistoricalOrders.mockClear();

      // when
      await internals._resumePendingPlacements();

      // then
      expect(earliestStart(getHistoricalOrders)).toBe(
        Date.parse(state.createdAt) - DAY,
      );
    });
  });

  it("adopts a pending sell that is still open on the exchange", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      active: [
        exchangeOrder({
          id: "open-sell",
          client_order_id: "stale-sell",
          side: "sell",
          status: "new",
        }),
      ],
    });
    const position = pendingSell(state);

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(position.sellOrderId).toBe("open-sell");
    expect(position.sellBaseSize).toBe("0.1");
  });

  it("holds a pending sell the exchange already rejected at start-up and replaces it 5 minutes later", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = recoveryInternals({
      historical: [
        exchangeOrder({
          id: "old-rejected-sell",
          client_order_id: "stale-sell",
          side: "sell",
        }),
      ],
      placeOrder: (request) => ({
        data: {
          venue_order_id: "fresh-sell",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });
    const position = pendingSell(state);
    await internals._resumePendingPlacements();
    const sentAtStartUp = placeOrder.mock.calls.length;

    // when
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await internals._sweepPendingIntents(new Map());

    // then
    expect(sentAtStartUp).toBe(0);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const request = placeOrder.mock.calls[0][0];
    expect(request.side).toBe("sell");
    expect(request.clientOrderId).not.toBe("stale-sell");
    expect(position.sellOrderId).toBe("fresh-sell");
    expect(position.sellClientOrderId).toBe(request.clientOrderId);
  });

  it("re-sends a pending sell that never reached the exchange with its original id", async () => {
    // given
    const { state, internals, placeOrder } = recoveryInternals({
      placeOrder: (request) => ({
        data: {
          venue_order_id: "resent-sell",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });
    const position = pendingSell(state);

    // when
    await internals._resumePendingPlacements();

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0]).toMatchObject({
      side: "sell",
      clientOrderId: "stale-sell",
    });
    expect(position.sellOrderId).toBe("resent-sell");
  });

  it("looks up all pending orders with one history scan back to the grid's start", async () => {
    // given
    const { state, internals, getHistoricalOrders } = recoveryInternals({
      historical: [
        exchangeOrder({ id: "old-rejected" }),
        exchangeOrder({ id: "old-rejected-2", client_order_id: "stale-2" }),
      ],
      placeOrder: async (request) => ({
        data: {
          venue_order_id: `fresh-${request.clientOrderId}`,
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });
    state.levels[1].pendingBuyClientOrderIds = ["stale-2"];
    state.levels[1].pendingBuyQuoteSizes = { "stale-2": "10" };

    // when
    await internals._resumePendingPlacements();

    // then
    expect(getHistoricalOrders).toHaveBeenCalledTimes(1);
    expect(getHistoricalOrders.mock.calls[0][0].startDate).toBe(
      Date.parse(state.createdAt) - 24 * 60 * 60 * 1000,
    );
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["stale-client"]);
    expect(state.levels[1].pendingBuyClientOrderIds).toEqual(["stale-2"]);
  });

  it("does not query the exchange when nothing is pending", async () => {
    // given
    const { state, internals, placeOrder, getHistoricalOrders } =
      recoveryInternals();
    state.levels[0].pendingBuyClientOrderIds = [];

    // when
    await internals._resumePendingPlacements();

    // then
    expect(getHistoricalOrders).not.toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("grid bot trailing-up confirmation", () => {
  it("requires three consecutive qualifying live prices", () => {
    // given
    const state = makeState();
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: true,
      reset: false,
      trailingUp: true,
    });
    const internals = bot as unknown as {
      _state: GridState;
      _shouldRebuildUp: boolean;
      _checkBoundary: (price: Decimal) => void;
    };
    internals._state = state;
    const trigger = new Decimal("102.030405060708091011");

    // when
    internals._checkBoundary(trigger);
    const afterFirst = internals._shouldRebuildUp;
    internals._checkBoundary(trigger.plus("1"));
    const afterSecond = internals._shouldRebuildUp;
    internals._checkBoundary(trigger.plus("2"));

    // then
    expect([afterFirst, afterSecond, internals._shouldRebuildUp]).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("grid bot trailing up while the grid holds coins", () => {
  function trailingBot(dryRun: boolean) {
    const state = makeState();
    state.config.dryRun = dryRun;
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      { id: "held", baseHeld: "0.1", fillCost: "9.9", sellOrderId: null },
    ];
    const placed = new Set<string>();
    const placeOrder = vi.fn(async (request: { clientOrderId: string }) => {
      placed.add(`placed-${request.clientOrderId}`);
      return {
        data: {
          venue_order_id: `placed-${request.clientOrderId}`,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    const client = {
      placeOrder,
      cancelOrder: vi.fn(async () => undefined),
      getActiveOrders: vi.fn(async () => ({
        data: [...placed].map((id) => ({ id, status: "new" })),
        metadata: {},
      })),
      getHistoricalOrders: vi.fn(async () => ({ data: [], metadata: {} })),
      getOrder: vi.fn(async (id: string) => ({
        data: { id, status: "new", filled_quantity: "0" },
      })),
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun,
        reset: false,
        trailingUp: true,
      },
      { suppressDashboard: true, trailingUpConfirmationTicks: 1 },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: typeof client;
      _warnings: string[];
      _tick: (price: Decimal) => Promise<void>;
      _rebuildGridUp: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = client;
    const rebuild = vi.fn(async () => undefined);
    internals._rebuildGridUp = rebuild;
    return { state, internals, rebuild };
  }

  const DEFERRED =
    "Trailing up deferred: open positions or unresolved placements present, will retry next tick";

  it("waits while a live grid holds coins and rebuilds on the next qualifying price once they are sold", async () => {
    // given
    const { state, internals, rebuild } = trailingBot(false);
    await internals._tick(new Decimal("103"));
    const warningsWhileHeld = [...internals._warnings];
    const rebuildsWhileHeld = rebuild.mock.calls.length;
    state.levels[0].positions = [];

    // when
    await internals._tick(new Decimal("103"));

    // then
    expect(rebuildsWhileHeld).toBe(0);
    expect(warningsWhileHeld).toContain(DEFERRED);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("waits while a dry-run grid holds coins and rebuilds once its sell fills", async () => {
    // given
    const { internals, rebuild } = trailingBot(true);
    await internals._tick(new Decimal("103"));
    const warningsWhileHeld = [...internals._warnings];
    const rebuildsWhileHeld = rebuild.mock.calls.length;

    // when
    await internals._tick(new Decimal("103"));

    // then
    expect(rebuildsWhileHeld).toBe(0);
    expect(warningsWhileHeld).toContain(DEFERRED);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});

describe("grid bot split buy with a lost reply at start-up", () => {
  type Request = { clientOrderId: string; market?: { quoteSize?: string } };

  function listedSplit(): Order {
    return {
      id: "split-1",
      client_order_id: "split-lost",
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      quantity: "0.2",
      filled_quantity: "0.2",
      leaves_quantity: "0",
      price: "100",
      status: "filled",
      time_in_force: "ioc",
      execution_instructions: [],
      created_date: 1,
      updated_date: 1,
    };
  }

  function splitBot(
    exchange: {
      historical?: Order[];
      orders?: Record<string, Record<string, string>>;
      placeOrder?: (request: Request) => unknown;
    } = {},
  ) {
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.config.splitInvestment = true;
    state.initializing = true;
    state.splitClientOrderId = "split-lost";
    state.splitOrderQuoteSize = "20";
    state.splitRemainingQuote = "20";
    const placeOrder = vi.fn(async (request: Request) =>
      exchange.placeOrder
        ? exchange.placeOrder(request)
        : {
            data: {
              venue_order_id: "split-1",
              client_order_id: request.clientOrderId,
              state: "new" as const,
            },
          },
    );
    const getOrder = vi.fn(async (id: string) => ({
      data: {
        id,
        status: "filled",
        filled_quantity: "0.2",
        filled_amount: "20",
        average_fill_price: "100",
        total_fee: "0",
        fee_currency: "BTC",
        ...exchange.orders?.[id],
      },
    }));
    const getActiveOrders = vi.fn(async () => ({ data: [], metadata: {} }));
    const getHistoricalOrders = vi.fn(
      async (request: { startDate: number; endDate: number }) => ({
        data:
          request.startDate <= request.endDate
            ? (exchange.historical ?? [])
            : [],
        metadata: {},
      }),
    );
    const output: string[] = [];
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: true,
        intervalSec: 30,
        dryRun: false,
        reset: false,
        trailingUp: false,
      },
      {
        humanOutput: {
          write: (chunk: string) => {
            output.push(chunk);
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: {
        placeOrder: typeof placeOrder;
        getOrder: typeof getOrder;
        getActiveOrders: typeof getActiveOrders;
        getHistoricalOrders: typeof getHistoricalOrders;
      };
      _executeSplitMarketBuy: (
        totalQuote: Decimal,
      ) => Promise<{ base: Decimal; cost: Decimal; fee: Decimal }>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
    };
    const text = () => stripVTControlCharacters(output.join(""));
    return { state, internals, placeOrder, text };
  }

  it("says it looks up the split buy sent earlier", async () => {
    // given
    const { internals, text } = splitBot({ historical: [listedSplit()] });

    // when
    await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(text()).toContain(
      "Looking up the split buy sent earlier, client order ID split-lost...",
    );
    expect(text()).not.toContain("Market buy placed");
  });

  it("says a split buy whose reply was lost may have gone through and how to go on", async () => {
    // given
    const { internals, text } = splitBot({
      placeOrder: () => {
        throw new NetworkError("No reply from the exchange.");
      },
    });

    // when
    const split = internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    await expect(split).rejects.toThrow(
      "The split buy may have been placed, but its reply was lost: No reply from the exchange. Client order ID: split-lost. Run the same command again. It looks the buy up before sending anything.",
    );
    expect(text()).not.toContain("Market buy placed");
  });

  it("says the market buy is placed only once the exchange took it", async () => {
    // given
    const { state, internals, text } = splitBot();
    state.splitClientOrderId = undefined;
    state.splitOrderQuoteSize = undefined;

    // when
    await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(text()).toContain(
      "Placing market buy for 20 USD...\n  Market buy placed: 20 USD. Waiting for fill...",
    );
  });

  it("follows a split buy it finds by its id instead of sending it again", async () => {
    // given
    const { state, internals, placeOrder } = splitBot({
      historical: [listedSplit()],
    });

    // when
    const split = await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(split.base.toString()).toBe("0.2");
    expect(state.splitClientOrderId).toBeUndefined();
  });

  it("sends only the rest of a split buy it finds partly filled, with a new id", async () => {
    // given
    const { internals, placeOrder } = splitBot({
      historical: [listedSplit()],
      orders: {
        "split-1": {
          status: "cancelled",
          filled_quantity: "0.1",
          filled_amount: "10",
        },
      },
      placeOrder: (request) => ({
        data: {
          venue_order_id: "split-2",
          client_order_id: request.clientOrderId,
          state: "new",
        },
      }),
    });

    // when
    const split = await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).not.toBe("split-lost");
    expect(placeOrder.mock.calls[0][0].market?.quoteSize).toBe("10");
    expect(split.base.toString()).toBe("0.3");
  });

  it("passes on any other error from sending the split buy", async () => {
    // given
    const { internals } = splitBot({
      placeOrder: () => {
        throw new Error("socket hang up");
      },
    });

    // when
    const split = internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    await expect(split).rejects.toThrow("socket hang up");
  });

  it("sends a split buy that never reached the exchange again with its own id", async () => {
    // given
    const { internals, placeOrder } = splitBot();

    // when
    await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0][0].clientOrderId).toBe("split-lost");
  });

  it("stops start-up with a clear message when the exchange has the split buy but doesn't list it yet", async () => {
    // given
    const { state, internals } = splitBot({
      placeOrder: (request) => {
        throw new BadRequestError(
          `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
        );
      },
    });

    // when
    const split = internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    await expect(split).rejects.toThrow(
      "The split buy split-lost was already sent, but the exchange doesn't list it yet. Start again in a few minutes.",
    );
    expect(state.splitClientOrderId).toBe("split-lost");
  });
});

describe("grid bot orders the exchange doesn't list yet", () => {
  const FIVE_MINUTES = 5 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  type PlaceRequest = {
    clientOrderId: string;
    side: "buy" | "sell";
    limit: { price: string };
  };

  function unlistedBot(
    options: {
      orders?: Record<string, Partial<OrderDetails>>;
      active?: Array<string | Partial<Order>>;
      historical?: Array<Partial<Order>>;
      splitInvestment?: boolean;
      reset?: boolean;
    } = {},
  ) {
    const state = makeState();
    const output: string[] = [];
    const notify = vi.fn();
    const listed = { ...(options.orders ?? {}) };
    const placeOrder = vi.fn(async (request: PlaceRequest) => ({
      data: {
        venue_order_id: `${request.side}-${request.limit.price}`,
        client_order_id: request.clientOrderId,
        state: "new" as const,
      },
    }));
    const getOrder = vi.fn(async (id: string) => {
      const order = listed[id];
      if (!order) throw new NotFoundError(`Order with ID '${id}' not found.`);
      return {
        data: {
          id,
          client_order_id: id,
          status: "new",
          filled_quantity: "0",
          filled_amount: "0",
          total_fee: "0",
          fee_currency: "USD",
          ...order,
        } as OrderDetails,
      };
    });
    const getActiveOrders = vi.fn(async () => ({
      data: (options.active ?? []).map((entry) =>
        typeof entry === "string" ? { id: entry, status: "new" } : entry,
      ),
      metadata: {},
    }));
    const getHistoricalOrders = vi.fn(async () => ({
      data: options.historical ?? [],
      metadata: {},
    }));
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: options.splitInvestment ?? false,
        intervalSec: 30,
        dryRun: false,
        reset: options.reset ?? false,
        trailingUp: false,
      },
      {
        suppressDashboard: true,
        humanOutput: {
          write: (chunk: string) => {
            output.push(chunk);
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _warnings: string[];
      _client: Record<string, unknown>;
      _tick: (price: Decimal) => Promise<void>;
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
      _attentionLines: () => string[];
      _hasUnresolvedPlacementIntents: () => boolean;
      _pruneMissing: (state: GridState) => void;
      _cancelUntilClosed: (
        orderId: string,
      ) => Promise<{ closed: boolean; order: OrderDetails | null }>;
      _closeGridOrders: (
        state: GridState,
        policy: "settle" | "keepTraded",
      ) => Promise<{
        cancelled: number;
        problems: string[];
        unlisted: string[];
      }>;
      _discardSavedGrid: (state: GridState) => Promise<void>;
      _startFromSave: () => Promise<void>;
      _initNewGrid: () => Promise<void>;
      _liquidate: (reason: "stop-loss", price: Decimal) => Promise<void>;
      _sellOffMessage: string | null;
      _notify: typeof notify;
      _openBuyFills: Decimal;
      _startup: Promise<void> | null;
      _rateLimiter: {
        query: (fn: () => Promise<unknown>) => Promise<unknown>;
        place: (
          fn: () => Promise<unknown>,
          refuse?: () => Error | null,
        ) => Promise<unknown>;
      };
      _placeBuyOrAlert: (
        level: GridState["levels"][number],
      ) => Promise<string | null>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._notify = notify;
    internals._client = {
      placeOrder,
      getOrder,
      getActiveOrders,
      getHistoricalOrders,
      getBalances: vi.fn(async () => [{ currency: "USD", available: "1000" }]),
    };
    const sells = () =>
      placeOrder.mock.calls
        .map(([request]) => request)
        .filter((request) => request.side === "sell");
    const readIds = () => getOrder.mock.calls.map(([id]) => id);
    const text = () => stripVTControlCharacters(output.join(""));
    return {
      bot,
      state,
      internals,
      placeOrder,
      getOrder,
      getHistoricalOrders,
      notify,
      sells,
      readIds,
      text,
      listed,
    };
  }

  function heldWithSell(state: GridState, sellOrderId: string): void {
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "p1",
        baseHeld: "0.1",
        fillCost: "10",
        slotQuote: "10",
        sellOrderId,
        sellClientOrderId: `c-${sellOrderId}`,
        sellBaseSize: "0.1",
      },
    ];
  }

  function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  const FILLED_BUY: Partial<OrderDetails> = {
    status: "filled",
    filled_quantity: "0.1",
    filled_amount: "9.9",
    average_fill_price: "99",
  };

  it("places one sell for a buy that filled while the bot was down, and doesn't read it back during the restart", async () => {
    // given
    const { state, internals, sells, readIds } = unlistedBot({
      orders: { "buy-1": FILLED_BUY },
    });

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(sells()).toHaveLength(1);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-99.1");
    expect(readIds()).toEqual(["buy-1"]);
  });

  it("keeps the restart's new sell when the first check can't find it yet", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells, text } = unlistedBot({
      orders: { "buy-1": FILLED_BUY },
    });
    await internals._reconcileAndInit(state);

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toHaveLength(1);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-99.1");
    expect(state.missingSince).toEqual({
      "sell-99.1": new Date().toISOString(),
    });
    expect(internals._attentionLines().join("\n")).not.toContain("not listed");
    expect(text()).not.toContain("expired/cancelled");
  });

  it("doesn't read back a sell placed earlier in the same check", async () => {
    // given
    const { state, internals, sells, readIds } = unlistedBot({
      orders: { "buy-1": FILLED_BUY },
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toHaveLength(1);
    expect(readIds()).toEqual(["buy-1"]);
    expect(internals._warnings.join("\n")).not.toContain("Check sell");
  });

  it("keeps a saved sell the restart can't find, and doesn't count it as gone", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells, text } = unlistedBot();
    heldWithSell(state, "sell-saved");

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(sells()).toHaveLength(0);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-saved");
    expect(state.missingSince).toEqual({
      "sell-saved": new Date().toISOString(),
    });
    expect(text()).toContain(
      "1 order not listed by the exchange yet, looked up again",
    );
    expect(text()).not.toContain("expired/cancelled");
  });

  it("keeps waiting for a sell missing just under five minutes", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells } = unlistedBot();
    heldWithSell(state, "sell-saved");
    const firstMiss = new Date(Date.now() - FIVE_MINUTES + 1).toISOString();
    state.missingSince = { "sell-saved": firstMiss };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toHaveLength(0);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-saved");
    expect(state.missingSince).toEqual({ "sell-saved": firstMiss });
  });

  it("sends a sell missing for five minutes again under its own client order id", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells } = unlistedBot();
    heldWithSell(state, "sell-saved");
    state.missingSince = {
      "sell-saved": new Date(Date.now() - FIVE_MINUTES).toISOString(),
    };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toEqual([
      expect.objectContaining({
        clientOrderId: "c-sell-saved",
        limit: expect.objectContaining({ price: "99.1" }),
      }),
    ]);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-99.1");
    expect(state.missingSince).toEqual({});
    expect(internals._warnings).toContain(
      "Sell @99.1 not listed by the exchange for 5 minutes, sending it again under its own client order ID",
    );
  });

  it("keeps a saved buy at restart however long it has been missing, and the first check sends it again under its own client order id", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder, text } = unlistedBot();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[0].buyClientOrderIds = { "buy-1": "c-buy-1" };
    state.missingSince = { "buy-1": minutesAgo(30) };

    // when
    await internals._reconcileAndInit(state);
    const afterRestart = [...state.levels[0].buyOrderIds];
    await internals._tick(new Decimal("99.5"));

    // then
    expect(afterRestart).toEqual(["buy-1"]);
    expect(text()).toContain(
      "1 order not listed by the exchange yet, looked up again",
    );
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "buy",
        clientOrderId: "c-buy-1",
        limit: expect.objectContaining({ price: "99", quoteSize: "10" }),
      }),
    );
    expect(state.levels[0].buyOrderIds).toEqual(["buy-99"]);
    expect(state.levels[0].buyClientOrderIds).toEqual({ "buy-99": "c-buy-1" });
  });

  it("looks up a re-sent buy the exchange already has instead of placing a second one", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = unlistedBot();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[0].buyClientOrderIds = { "buy-1": "c-buy-1" };
    state.missingSince = { "buy-1": minutesAgo(6) };
    placeOrder.mockImplementation(async (request: PlaceRequest) => {
      if (request.clientOrderId === "c-buy-1") {
        throw new BadRequestError(
          "An order with the client_order_id 'c-buy-1' has already been placed",
        );
      }
      return {
        data: {
          venue_order_id: `${request.side}-${request.limit.price}`,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    const level0Buys = placeOrder.mock.calls
      .map(([request]) => request)
      .filter((request) => request.limit.price === "99");
    expect(level0Buys.map((request) => request.clientOrderId)).toEqual([
      "c-buy-1",
    ]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["c-buy-1"]);
  });

  it("books a re-sent buy's original exactly once when the exchange already filled it", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const filledOriginal = {
      id: "buy-1",
      client_order_id: "c-buy-1",
      status: "filled" as const,
      filled_quantity: "0.1",
      filled_amount: "9.9",
      average_fill_price: "99",
    };
    const { state, internals, placeOrder, sells, listed } = unlistedBot({
      historical: [filledOriginal],
    });
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[0].buyClientOrderIds = { "buy-1": "c-buy-1" };
    state.missingSince = { "buy-1": minutesAgo(6) };
    placeOrder.mockImplementation(async (request: PlaceRequest) => {
      if (request.clientOrderId === "c-buy-1") {
        throw new BadRequestError(
          "An order with the client_order_id 'c-buy-1' has already been placed",
        );
      }
      return {
        data: {
          venue_order_id: `${request.side}-${request.limit.price}`,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));
    listed["buy-1"] = filledOriginal;
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.stats.totalBuys).toBe(1);
    expect(sells()).toHaveLength(1);
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(state.levels[0].buyClientOrderIds?.["buy-1"]).toBeUndefined();
  });

  it("recovers the client order id of an older saved buy from the order history", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = unlistedBot({
      historical: [{ id: "buy-1", client_order_id: "c-legacy", status: "new" }],
    });
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "buy", clientOrderId: "c-legacy" }),
    );
    expect(internals._warnings).toContain(
      "Buy @99 not listed by the exchange for 5 minutes, sending it again under its own client order ID",
    );
  });

  it("learns a saved buy's client order id when the restart reads it", async () => {
    // given
    const { state, internals } = unlistedBot({
      orders: { "buy-1": { status: "new", client_order_id: "c-legacy" } },
    });

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(state.levels[0].buyClientOrderIds).toEqual({ "buy-1": "c-legacy" });
  });

  it("learns a buy's client order id from the active list without reading the order", async () => {
    // given
    const { state, internals, readIds } = unlistedBot({
      active: [{ id: "buy-1", status: "new", client_order_id: "c-legacy" }],
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.levels[0].buyClientOrderIds?.["buy-1"]).toBe("c-legacy");
    expect(readIds()).not.toContain("buy-1");
  });

  it("learns an older sell's client order id from the active list", async () => {
    // given
    const { state, internals } = unlistedBot({
      active: [{ id: "sell-1", status: "new", client_order_id: "c-old-sell" }],
    });
    heldWithSell(state, "sell-1");
    state.levels[0].positions[0].sellClientOrderId = undefined;
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.levels[0].positions[0].sellClientOrderId).toBe("c-old-sell");
  });

  it("keeps a buy with no client order id that stays unlisted, and alerts once", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder, getHistoricalOrders, notify } =
      unlistedBot();
    const firstMiss = minutesAgo(6);
    state.missingSince = { "buy-1": firstMiss };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));
    const historyReads = getHistoricalOrders.mock.calls.length;
    await internals._tick(new Decimal("99.5"));

    // then
    const level0Buys = placeOrder.mock.calls
      .map(([request]) => request)
      .filter((request) => request.limit.price === "99");
    expect(level0Buys).toEqual([]);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(state.missingSince?.["buy-1"]).toBe(firstMiss);
    expect(historyReads).toBeGreaterThan(0);
    expect(getHistoricalOrders).toHaveBeenCalledTimes(historyReads);
    expect(internals._attentionLines()).toContain(
      "Buy @99 not listed by the exchange, client order ID unknown, not sent again",
    );
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      "Grid Bot BTC-USD: the buy at $99 (order buy-1) isn't listed by the exchange, and its client order ID is unknown, so the bot doesn't send it again. Check the BTC-USD orders in the Revolut X app. If it doesn't show up within 24 hours of going missing, the bot places a new buy.",
    ]);
  });

  it("places one new buy once a buy with no client order id has been unlisted for 24 hours", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder, notify } = unlistedBot();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.missingSince = { "buy-1": minutesAgo(24 * 60 + 1) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    const level0Buys = placeOrder.mock.calls
      .map(([request]) => request)
      .filter((request) => request.limit.price === "99");
    expect(level0Buys).toHaveLength(1);
    expect(level0Buys[0].clientOrderId).not.toBe("buy-1");
    expect(state.levels[0].buyOrderIds).toEqual(["buy-99"]);
    expect(state.levels[0].buyClientOrderIds).toEqual({
      "buy-99": level0Buys[0].clientOrderId,
    });
    expect(state.missingSince ?? {}).toEqual({});
    expect(internals._warnings).toContain(
      "Buy @99 not listed by the exchange for 24 hours, client order ID unknown, placing a new buy",
    );
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      "Grid Bot BTC-USD: the buy at $99 (order buy-1) was not listed by the exchange for 24 hours, so the bot stops waiting for it and places a new buy.",
    ]);
  });

  it("keeps an older sell with no client order id that stays unlisted, and alerts once", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells, notify } = unlistedBot();
    heldWithSell(state, "sell-1");
    state.levels[0].positions[0].sellClientOrderId = undefined;
    state.missingSince = { "sell-1": minutesAgo(6) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toEqual([]);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-1");
    expect(internals._attentionLines()).toContain(
      "Sell @99.1 not listed by the exchange, client order ID unknown, not sent again",
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("places one new sell once an older sell with no client order id has been unlisted for 24 hours", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, sells } = unlistedBot();
    heldWithSell(state, "sell-1");
    state.levels[0].positions[0].sellClientOrderId = undefined;
    state.missingSince = { "sell-1": minutesAgo(24 * 60 + 1) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(sells()).toHaveLength(1);
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-99.1");
    expect(state.levels[0].positions[0].sellClientOrderId).toBe(
      sells()[0].clientOrderId,
    );
    expect(internals._warnings).toContain(
      "Sell @99.1 not listed by the exchange for 24 hours, client order ID unknown, placing a new sell",
    );
  });

  it("keeps holding a buy with no client order id just before 24 hours", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = unlistedBot();
    state.missingSince = { "buy-1": minutesAgo(24 * 60 - 1) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    const level0Buys = placeOrder.mock.calls
      .map(([request]) => request)
      .filter((request) => request.limit.price === "99");
    expect(level0Buys).toEqual([]);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
  });

  it("looks in the history again before replacing a held buy, and sends it under the id found there", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder, getHistoricalOrders, notify } =
      unlistedBot();
    state.missingSince = { "buy-1": minutesAgo(24 * 60 - 1) };
    internals._state = state;
    await internals._tick(new Decimal("99.5"));
    getHistoricalOrders.mockResolvedValue({
      data: [{ id: "buy-1", client_order_id: "c-late", status: "new" }],
      metadata: {},
    });

    // when
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await internals._tick(new Decimal("99.5"));

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "buy", clientOrderId: "c-late" }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("looks the history up at most once a minute while it can't be read", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, getHistoricalOrders, notify } = unlistedBot();
    getHistoricalOrders.mockRejectedValue(new Error("Service unavailable"));
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));
    const afterFirst = getHistoricalOrders.mock.calls.length;
    await internals._tick(new Decimal("99.5"));
    const afterSecond = getHistoricalOrders.mock.calls.length;
    vi.setSystemTime(Date.now() + 61_000);
    await internals._tick(new Decimal("99.5"));

    // then
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
    expect(getHistoricalOrders).toHaveBeenCalledTimes(2);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(internals._warnings).toContain(
      "Check buy #1: Service unavailable (will retry)",
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops holding a buy with no client order id once the exchange lists it", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, listed } = unlistedBot();
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;
    await internals._tick(new Decimal("99.5"));

    // when
    listed["buy-1"] = { status: "new", client_order_id: "c-found" };
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.missingSince?.["buy-1"]).toBeUndefined();
    expect(state.levels[0].buyClientOrderIds?.["buy-1"]).toBe("c-found");
    expect(internals._attentionLines().join("\n")).not.toContain(
      "client order ID unknown",
    );
  });

  it("learns a buy's client order id when a check reads it on its own", async () => {
    // given
    const { state, internals } = unlistedBot({
      orders: { "buy-1": { status: "new", client_order_id: "c-read" } },
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.levels[0].buyClientOrderIds?.["buy-1"]).toBe("c-read");
  });

  it("says in the alert that trailing up waits for a held order", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, notify } = unlistedBot();
    (
      internals as unknown as { _config: { trailingUp: boolean } }
    )._config.trailingUp = true;
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(String(notify.mock.calls[0][0])).toMatch(
      / Trailing up waits until then\.$/,
    );
  });

  it("still lets a stop-loss forget a buy with no client order id after 5 minutes unlisted", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals } = unlistedBot();
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;
    internals._cancelUntilClosed = async () => ({ closed: true, order: null });

    // when
    const result = await internals._closeGridOrders(state, "settle");

    // then
    expect(result.problems).toEqual([]);
    expect(state.levels[0].buyOrderIds).toEqual([]);
  });

  it("counts what an open buy has bought when a check reads it on its own", async () => {
    // given
    const partial = {
      id: "buy-1",
      status: "partially_filled" as const,
      client_order_id: "c-buy-1",
      filled_quantity: "0.03",
    };
    const { state, internals } = unlistedBot({
      orders: { "buy-1": partial },
    });
    const getActiveOrders = internals._client.getActiveOrders as ReturnType<
      typeof vi.fn
    >;
    getActiveOrders
      .mockResolvedValueOnce({ data: [], metadata: {} })
      .mockResolvedValue({ data: [partial], metadata: {} });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(internals._openBuyFills.toString()).toBe("0.03");
    expect(state.levels[0].positions).toEqual([]);
  });

  it("shows no open buy fills from an earlier check when the orders can't be read", async () => {
    // given
    const { state, internals } = unlistedBot();
    internals._state = state;
    internals._openBuyFills = new Decimal("0.04");
    internals._client.getActiveOrders = vi.fn(async () => {
      throw new Error("Service unavailable");
    });

    // when
    const check = internals._tick(new Decimal("99.5"));

    // then
    await expect(check).rejects.toThrow("Failed to fetch active orders");
    expect(internals._openBuyFills.toString()).toBe("0");
  });

  it("shows how much an open buy has already bought, without booking it", async () => {
    // given
    const { state, internals } = unlistedBot({
      active: [
        {
          id: "buy-1",
          status: "partially_filled",
          client_order_id: "c-buy-1",
          filled_quantity: "0.04",
        },
      ],
    });
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(internals._openBuyFills.toString()).toBe("0.04");
    expect(state.levels[0].positions).toEqual([]);
    expect(state.stats.totalBuys).toBe(0);
  });

  it("finishes a stop-loss sale in the same run once a fresh grid order is listed", async () => {
    // given
    vi.useFakeTimers();
    const { state, internals } = unlistedBot();
    internals._state = state;
    const cancelled = {
      id: "buy-1",
      client_order_id: "c-buy-1",
      status: "cancelled",
      filled_quantity: "0",
    } as OrderDetails;
    const answers = [null, null, cancelled];
    internals._cancelUntilClosed = async () => ({
      closed: true,
      order: answers.length > 1 ? answers.shift()! : answers[0],
    });

    // when
    const selling = internals._liquidate("stop-loss", new Decimal("98"));
    await vi.advanceTimersByTimeAsync(65_000);
    await selling;

    // then
    expect(state.halt).toBeUndefined();
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(internals._sellOffMessage).not.toContain("isn't listed");
  });

  it("gives up on a grid order that never gets listed after 5 minutes and finishes the sale", async () => {
    // given
    vi.useFakeTimers();
    const { state, internals, notify } = unlistedBot();
    internals._state = state;
    internals._cancelUntilClosed = async () => ({ closed: true, order: null });

    // when
    const selling = internals._liquidate("stop-loss", new Decimal("98"));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await selling;

    // then
    expect(state.halt).toBeUndefined();
    expect(state.levels[0].buyOrderIds).toEqual([]);
    expect(
      notify.mock.calls.filter(([message]) =>
        String(message).includes("checks again every 30 seconds"),
      ),
    ).toHaveLength(1);
  });

  it("stops waiting for an unlisted grid order on Ctrl+C and keeps the sale for the next start", async () => {
    // given
    vi.useFakeTimers();
    const { state, internals, bot } = unlistedBot();
    internals._state = state;
    internals._cancelUntilClosed = async () => ({ closed: true, order: null });

    (internals as unknown as { _printSellOff: () => void })._printSellOff =
      () => undefined;

    // when
    const selling = internals._liquidate("stop-loss", new Decimal("98"));
    await vi.advanceTimersByTimeAsync(0);
    const stopping = bot.shutdown();
    await selling;
    await stopping;

    // then
    expect(state.halt).toEqual({ reason: "stop-loss", triggerPrice: "98" });
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(internals._sellOffMessage).toContain(
      "Last error: Order buy-1 isn't listed by the exchange yet, so its cancel can't be confirmed. Start again in a few minutes.",
    );
  });

  it("sends no grid order once Ctrl+C was pressed", async () => {
    // given
    const { state, internals, placeOrder } = unlistedBot();
    internals._state = state;
    stopRequest(internals).abort();

    // when
    const placed = await internals._placeBuyOrAlert(state.levels[1]);

    // then
    expect(placed).toBeNull();
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[1].pendingBuyClientOrderIds ?? []).toEqual([]);
  });

  it("keeps the client order id of a buy it was sending again when Ctrl+C comes", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals, placeOrder } = unlistedBot();
    state.levels[0].buyOrderQuoteSizes = { "buy-1": "10" };
    state.levels[0].buyClientOrderIds = { "buy-1": "c-buy-1" };
    state.missingSince = { "buy-1": minutesAgo(6) };
    internals._state = state;
    stopRequest(internals).abort();

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["c-buy-1"]);
    expect(state.levels[0].pendingBuyQuoteSizes).toEqual({ "c-buy-1": "10" });
  });

  it("keeps waiting through a cancel that fails once and then finishes the sale", async () => {
    // given
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const { state, internals } = unlistedBot();
    internals._state = state;
    const cancelled = {
      id: "buy-1",
      client_order_id: "c-buy-1",
      status: "cancelled",
      filled_quantity: "0",
    } as OrderDetails;
    const answers: Array<{ closed: boolean; order?: OrderDetails | null }> = [
      { closed: true, order: null },
      { closed: false },
      { closed: true, order: cancelled },
    ];
    internals._cancelUntilClosed = async () =>
      (answers.length > 1 ? answers.shift()! : answers[0]) as {
        closed: boolean;
        order: OrderDetails | null;
      };

    // when
    const selling = internals._liquidate("stop-loss", new Decimal("98"));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await selling;

    // then
    expect(state.halt).toBeUndefined();
    expect(state.levels[0].buyOrderIds).toEqual([]);
  });

  it("gives the slot back when Ctrl+C stops the re-buy of a partly filled buy", async () => {
    // given
    const { state, internals, placeOrder } = unlistedBot();
    internals._state = state;
    const level = state.levels[0];
    level.buyOrderIds = ["buy-1"];
    level.buyOrderQuoteSizes = { "buy-1": "10" };
    stopRequest(internals).abort();

    // when
    await (
      internals as unknown as {
        _processTerminalBuy: (
          level: GridLevelState,
          order: OrderDetails,
          notify: boolean,
        ) => Promise<boolean>;
      }
    )._processTerminalBuy(
      level,
      {
        id: "buy-1",
        client_order_id: "c-buy-1",
        status: "cancelled",
        filled_quantity: "0.05",
        filled_amount: "4.95",
        average_fill_price: "99",
        total_fee: "0",
        fee_currency: "BTC",
      } as OrderDetails,
      false,
    );

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(level.pendingBuyClientOrderIds ?? []).toEqual([]);
    expect(level.positions).toHaveLength(1);
    expect(level.positions[0].slotQuote).toBe("10");
  });

  it("saves a grid it can resume when Ctrl+C comes while the split buy fills", async () => {
    // given
    const { internals, placeOrder, listed, text } = unlistedBot({
      splitInvestment: true,
    });
    const starting = internals as unknown as {
      _state: GridState | null;
      _priceSource: { peek: () => Promise<Decimal> };
      _initNewGrid: () => Promise<void>;
    };
    starting._state = null;
    starting._priceSource = { peek: async () => new Decimal("100") };
    placeOrder.mockImplementation(async (request: PlaceRequest) => {
      const id = `${request.side}-${placeOrder.mock.calls.length}`;
      listed[id] = {
        status: "filled",
        filled_quantity: "0.2",
        filled_amount: "20",
        average_fill_price: "100",
        total_fee: "0",
        fee_currency: "BTC",
      };
      stopRequest(internals).abort();
      return {
        data: {
          venue_order_id: id,
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });

    // when
    await starting._initNewGrid();

    // then
    const saved = starting._state!;
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(saved.initializing).toBe(true);
    expect(saved.splitExecuted).toBe(true);
    expect(saved.splitAccountingApplied).toBe(true);
    expect(saved.splitAccumulatedBase).toBe("0.2");
    expect(saved.levels.flatMap((level) => level.buyOrderIds)).toEqual([]);
    expect(saved.levels.flatMap((level) => level.positions)).toEqual([]);
    expect(text()).not.toContain("initial buy orders");
  });

  it("finishes the first placement on the next start after Ctrl+C during the split buy", async () => {
    // given
    const first = unlistedBot({ splitInvestment: true });
    const starting = first.internals as unknown as {
      _state: GridState | null;
      _priceSource: { peek: () => Promise<Decimal> };
      _initNewGrid: () => Promise<void>;
    };
    starting._state = null;
    starting._priceSource = { peek: async () => new Decimal("100") };
    first.placeOrder.mockImplementation(async (request: PlaceRequest) => {
      first.listed["split-buy"] = {
        status: "filled",
        filled_quantity: "0.2",
        filled_amount: "20",
        average_fill_price: "100",
        total_fee: "0",
        fee_currency: "BTC",
      };
      stopRequest(first.internals).abort();
      return {
        data: {
          venue_order_id: "split-buy",
          client_order_id: request.clientOrderId,
          state: "new" as const,
        },
      };
    });
    await starting._initNewGrid();
    const saved = structuredClone(starting._state!);
    const next = unlistedBot({ splitInvestment: true });
    (
      next.internals as unknown as {
        _priceSource: { peek: () => Promise<Decimal> };
      }
    )._priceSource = { peek: async () => new Decimal("100") };

    // when
    await next.internals._reconcileAndInit(saved);

    // then
    const resumed = next.internals._state;
    const sides = next.placeOrder.mock.calls.map(([request]) => request.side);
    expect(sides.filter((side) => side === "sell")).toHaveLength(2);
    expect(sides.filter((side) => side === "buy")).toHaveLength(2);
    expect(resumed.initializing).toBe(false);
    expect(
      resumed.levels.flatMap((level) => level.positions).map((p) => p.baseHeld),
    ).toEqual(["0.1", "0.1"]);
  });

  const COINS_NOTE =
    "Any BTC the old grid bought and didn't sell stays in the wallet. The new grid doesn't manage it.";

  function closesAs(
    internals: ReturnType<typeof unlistedBot>["internals"],
    outcomes: Record<string, { closed: boolean; order: OrderDetails | null }>,
  ): string[] {
    const cancelled: string[] = [];
    internals._cancelUntilClosed = async (orderId: string) => {
      cancelled.push(orderId);
      return (
        outcomes[orderId] ?? {
          closed: true,
          order: {
            id: orderId,
            side: "buy",
            status: "cancelled",
            filled_quantity: "0",
          } as OrderDetails,
        }
      );
    };
    return cancelled;
  }

  function filled(id: string, side: "buy" | "sell") {
    return {
      closed: true,
      order: {
        id,
        side,
        status: "filled",
        filled_quantity: "0.1",
      } as OrderDetails,
    };
  }

  describe("--reset", () => {
    beforeEach(() => {
      vi.mocked(deleteGridState).mockClear();
    });

    it("cancels the saved grid's orders, then deletes the save", async () => {
      // given
      const { state, internals, text, notify } = unlistedBot({ reset: true });
      const deletedAtCancel: boolean[] = [];
      closesAs(internals, {});
      const cancel = internals._cancelUntilClosed;
      internals._cancelUntilClosed = async (orderId: string) => {
        deletedAtCancel.push(vi.mocked(deleteGridState).mock.calls.length > 0);
        return cancel(orderId);
      };

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(deletedAtCancel).toEqual([false]);
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain("--reset flag: cancelling saved grid orders...");
      expect(text()).not.toContain("\u26A0");
      expect(text()).not.toContain("stays in the wallet");
      expect(notify).not.toHaveBeenCalled();
    });

    it("starts over while the old grid holds coins, which stay in the wallet", async () => {
      // given
      const { state, internals, text, placeOrder, notify } = unlistedBot({
        reset: true,
      });
      heldWithSell(state, "sell-1");
      const cancelled = closesAs(internals, {});

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled).toEqual(["sell-1"]);
      expect(placeOrder).not.toHaveBeenCalled();
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(COINS_NOTE);
      expect(notify).toHaveBeenCalledWith(
        `Grid Bot reset: BTC-USD\n${COINS_NOTE}`,
      );
    });

    it("drops a pending sell-off without selling", async () => {
      // given
      const { state, internals, text, placeOrder } = unlistedBot();
      heldWithSell(state, "sell-1");
      state.halt = { reason: "stop-loss", orderId: "sale-1" };
      const cancelled = closesAs(internals, {
        "sale-1": filled("sale-1", "sell"),
      });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled.sort()).toEqual(["sale-1", "sell-1"]);
      expect(placeOrder).not.toHaveBeenCalled();
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain("The old grid's pending sell-off is dropped.");
      expect(text()).toContain(COINS_NOTE);
    });

    it("says the coins stay when a buy filled during its cancel", async () => {
      // given
      const { state, internals, text } = unlistedBot();
      closesAs(internals, { "buy-1": filled("buy-1", "buy") });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(COINS_NOTE);
      expect(text()).not.toContain("\u26A0");
    });

    it("keeps the save and asks to run again when a cancel isn't confirmed", async () => {
      // given
      const { state, internals, text } = unlistedBot();
      state.levels[1].buyOrderIds = ["buy-2"];
      closesAs(internals, { "buy-1": { closed: false, order: null } });

      // when
      const reset = internals._discardSavedGrid(state);

      // then
      await expect(reset).rejects.toThrow(
        "The cancel of 1 order of the old grid isn't confirmed: buy-1. The next start cancels it again before it begins a new grid. If a grid order stays open, cancel it with revx order cancel <id> first.",
      );
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(saveGridState).toHaveBeenLastCalledWith(
        expect.objectContaining({ stopped: true }),
      );
      expect(text()).not.toContain("stays in the wallet");
    });

    it("keeps the save when signing is no longer safe", async () => {
      // given
      const { state, internals } = unlistedBot();
      internals._cancelUntilClosed = async () => {
        throw new InsecureKeyPermissionsError("unsafe", "/key");
      };

      // when
      const reset = internals._discardSavedGrid(state);

      // then
      await expect(reset).rejects.toBeInstanceOf(InsecureKeyPermissionsError);
      expect(deleteGridState).not.toHaveBeenCalled();
    });

    it("names the orders the exchange doesn't list yet and still starts over", async () => {
      // given
      const { state, internals, text, notify } = unlistedBot({ reset: true });
      state.levels[1].buyOrderIds = ["buy-2"];
      closesAs(internals, {
        "buy-1": { closed: true, order: null },
        "buy-2": { closed: true, order: null },
      });
      const note =
        "\u26A0 The exchange doesn't list 2 orders of the old grid: buy-1, buy-2. If revx order open --json shows one in the next few minutes, cancel it with revx order cancel <id>.";

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(note);
      expect(notify).toHaveBeenCalledWith(`Grid Bot reset: BTC-USD\n${note}`);
    });

    it("looks up orders sent with a lost reply, cancels them and names the ones it can't find", async () => {
      // given
      const { state, internals, text } = unlistedBot({
        active: [
          { id: "buy-9", client_order_id: "lost-buy", status: "new" },
          { id: "sell-9", client_order_id: "lost-sell", status: "new" },
          { id: "manual-1", client_order_id: "manual", status: "new" },
        ],
        historical: [
          { id: "split-9", client_order_id: "lost-split", status: "filled" },
        ],
      });
      state.levels[0].buyOrderIds = [];
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy", "gone-buy"];
      heldWithSell(state, "unused");
      state.levels[0].positions[0].sellOrderId = null;
      state.levels[0].positions[0].sellClientOrderId = "lost-sell";
      state.splitClientOrderId = "lost-split";
      const cancelled = closesAs(internals, {});

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled.sort()).toEqual(["buy-9", "sell-9", "split-9"]);
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(
        "\u26A0 The exchange doesn't list 1 order of the old grid: client order ID gone-buy. If revx order open --json shows it in the next few minutes, cancel it with revx order cancel <id>.",
      );
    });

    it("stops before cancelling anything when the orders can't be listed", async () => {
      // given
      const { state, internals } = unlistedBot();
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy"];
      internals._client.getActiveOrders = vi.fn(async () => {
        throw new Error("exchange down");
      });
      const cancelled = closesAs(internals, {});

      // when
      const reset = internals._discardSavedGrid(state);

      // then
      await expect(reset).rejects.toThrow("exchange down");
      expect(cancelled).toEqual([]);
      expect(deleteGridState).not.toHaveBeenCalled();
    });

    it("cancels a split buy still in flight and counts what it bought", async () => {
      // given
      const { state, internals, text } = unlistedBot();
      state.levels[0].buyOrderIds = [];
      state.splitOrderId = "split-1";
      const cancelled = closesAs(internals, {
        "split-1": filled("split-1", "buy"),
      });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled).toEqual(["split-1"]);
      expect(text()).toContain(COINS_NOTE);
    });

    it("warns that a split buy the exchange doesn't list may still trade", async () => {
      // given
      const { state, internals, text } = unlistedBot();
      state.levels[0].buyOrderIds = [];
      state.splitOrderId = "split-1";
      closesAs(internals, { "split-1": { closed: true, order: null } });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(
        "\u26A0 The exchange doesn't list 1 market order of the old grid: split buy split-1. It may still trade in the next few minutes. Check with revx order history.",
      );
      expect(text()).toContain(COINS_NOTE);
      expect(text()).not.toContain("revx order open --json");
    });

    it("looks up a sell-off sale known only by its client order ID", async () => {
      // given
      const { state, internals, text } = unlistedBot({
        historical: [
          { id: "sale-9", client_order_id: "sale-client", status: "filled" },
        ],
      });
      heldWithSell(state, "sell-1");
      state.halt = { reason: "stop-loss", clientOrderId: "sale-client" };
      const cancelled = closesAs(internals, {
        "sale-9": filled("sale-9", "sell"),
      });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled.sort()).toEqual(["sale-9", "sell-1"]);
      expect(text()).not.toContain("\u26A0");
    });

    it("names a sell-off sale it can't find as a market order", async () => {
      // given
      const { state, internals, text } = unlistedBot();
      state.levels[0].buyOrderIds = [];
      state.halt = { reason: "stop-loss", clientOrderId: "sale-client" };
      closesAs(internals, {});

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(text()).toContain(
        "\u26A0 The exchange doesn't list 1 market order of the old grid: sell-off sale client order ID sale-client. It may still trade in the next few minutes. Check with revx order history.",
      );
    });

    it("says the coins stay when a buy sent with a lost reply filled", async () => {
      // given
      const { state, internals, text } = unlistedBot({
        historical: [
          { id: "buy-8", client_order_id: "lost-buy", status: "filled" },
        ],
      });
      state.levels[0].buyOrderIds = [];
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy"];
      closesAs(internals, { "buy-8": filled("buy-8", "buy") });

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(text()).toContain(COINS_NOTE);
    });

    it("stops before cancelling anything when the order history can't be read", async () => {
      // given
      const { state, internals } = unlistedBot();
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy"];
      internals._client.getHistoricalOrders = vi.fn(async () => {
        throw new Error("history down");
      });
      const cancelled = closesAs(internals, {});

      // when
      const reset = internals._discardSavedGrid(state);

      // then
      await expect(reset).rejects.toThrow("history down");
      expect(cancelled).toEqual([]);
      expect(deleteGridState).not.toHaveBeenCalled();
    });

    it("starts a new grid after the reset, whatever the saved grid holds", async () => {
      // given
      const { state, internals } = unlistedBot({ reset: true });
      heldWithSell(state, "sell-1");
      state.halt = { reason: "stop-loss" };
      state.config.dryRun = true;
      vi.mocked(loadGridState).mockReturnValueOnce(state);
      closesAs(internals, {});
      const steps: string[] = [];
      vi.mocked(deleteGridState).mockImplementationOnce(() => {
        steps.push("delete");
      });
      internals._initNewGrid = async () => {
        steps.push("init");
      };
      internals._reconcileAndInit = async () => {
        steps.push("reconcile");
      };

      // when
      await internals._startFromSave();

      // then
      expect(steps).toEqual(["delete", "init"]);
    });

    it("starts a new grid from a stopped save without --reset", async () => {
      // given
      const { state, internals, text, notify } = unlistedBot();
      heldWithSell(state, "sell-1");
      state.stopped = true;
      vi.mocked(loadGridState).mockReturnValueOnce(state);
      closesAs(internals, {});
      const steps: string[] = [];
      vi.mocked(deleteGridState).mockImplementationOnce(() => {
        steps.push("delete");
      });
      internals._initNewGrid = async () => {
        steps.push("init");
      };
      internals._reconcileAndInit = async () => {
        steps.push("reconcile");
      };

      // when
      await internals._startFromSave();

      // then
      expect(steps).toEqual(["delete", "init"]);
      expect(text()).toContain(
        "Previous grid was stopped. Cancelling its leftover orders...",
      );
      expect(notify).toHaveBeenCalledWith(
        `Grid Bot previous run cleaned up: BTC-USD\n${COINS_NOTE}`,
      );
    });

    it("resumes a save left by a crash", async () => {
      // given
      const { state, internals } = unlistedBot();
      state.config.trailingUp = false;
      vi.mocked(loadGridState).mockReturnValueOnce(state);
      const steps: string[] = [];
      internals._initNewGrid = async () => {
        steps.push("init");
      };
      internals._reconcileAndInit = async () => {
        steps.push("reconcile");
      };

      // when
      await internals._startFromSave();

      // then
      expect(steps).toEqual(["reconcile"]);
      expect(deleteGridState).not.toHaveBeenCalled();
    });

    it("sends nothing to the exchange for a dry-run save", async () => {
      // given
      const { state, internals, text, notify } = unlistedBot();
      state.config.dryRun = true;
      heldWithSell(state, "dry-sell-1");
      state.levels[1].pendingBuyClientOrderIds = ["dry-pending"];
      const cancelled = closesAs(internals, {});

      // when
      await internals._discardSavedGrid(state);

      // then
      expect(cancelled).toEqual([]);
      expect(internals._client.getActiveOrders).not.toHaveBeenCalled();
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).not.toContain("cancelling saved grid orders");
      expect(text()).not.toContain("stays in the wallet");
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+C", () => {
    const STOP_COINS_NOTE =
      "Any BTC the grid bought and didn't sell stays in the wallet. The next start begins a new grid.";

    beforeEach(() => {
      vi.mocked(deleteGridState).mockClear();
      vi.mocked(saveGridState).mockClear();
    });

    it("ends the grid and deletes the save, even with coins held", async () => {
      // given
      const { bot, state, internals, text, placeOrder } = unlistedBot();
      heldWithSell(state, "sell-1");
      internals._state = state;
      const cancelled = closesAs(internals, {});

      // when
      await bot.shutdown();

      // then
      expect(cancelled).toEqual(["sell-1"]);
      expect(placeOrder).not.toHaveBeenCalled();
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain("Cancelled 1 order");
      expect(text()).toContain(STOP_COINS_NOTE);
      expect(text()).not.toContain("State saved");
    });

    it("says the exit is clean when the grid held nothing", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      closesAs(internals, {});

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain("All orders cancelled. Clean exit.");
      expect(text()).not.toContain("stays in the wallet");
    });

    it("ends the grid when an order traded while it was being cancelled", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      closesAs(internals, { "buy-1": filled("buy-1", "buy") });

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain(STOP_COINS_NOTE);
      expect(text()).not.toContain("\u26A0");
    });

    it("keeps a stopped save when a cancel isn't confirmed", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      closesAs(internals, { "buy-1": { closed: false, order: null } });

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(saveGridState).toHaveBeenLastCalledWith(
        expect.objectContaining({ stopped: true }),
      );
      expect(text()).toContain(
        "\u26A0 The cancel of 1 order isn't confirmed: buy-1.",
      );
      expect(text()).toContain(
        "The save is kept, so the next start checks these orders first, then begins a new grid.",
      );
    });

    it("keeps a stopped save when the orders can't be checked", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      state.levels[1].pendingBuyClientOrderIds = ["lost-buy"];
      internals._state = state;
      internals._client.getActiveOrders = vi.fn(async () => {
        throw new Error("exchange down");
      });
      closesAs(internals, {});

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(saveGridState).toHaveBeenLastCalledWith(
        expect.objectContaining({ stopped: true }),
      );
      expect(text()).toContain(
        "\u26A0 The grid's orders couldn't all be checked: exchange down.",
      );
      expect(text()).toContain(
        "The save is kept, so the next start checks these orders first, then begins a new grid.",
      );
    });

    it("keeps a stopped save while an order isn't listed yet", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      closesAs(internals, { "buy-1": { closed: true, order: null } });

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(saveGridState).toHaveBeenLastCalledWith(
        expect.objectContaining({ stopped: true }),
      );
      expect(text()).toContain(
        "\u26A0 The exchange doesn't list 1 order of the grid yet: buy-1.",
      );
      expect(text()).toContain(
        "The save is kept, so the next start checks these orders first, then begins a new grid.",
      );
    });

    it("keeps a stopped save when signing is no longer safe", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      internals._cancelUntilClosed = async () => {
        throw new InsecureKeyPermissionsError("unsafe", "/key");
      };

      // when
      await bot.shutdown();

      // then
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(text()).toContain(
        "\u26A0 Credential file permissions are unsafe, so open exchange orders may not be cancelled. Fix the key permissions, then cancel them with revx order cancel --all.",
      );
    });

    it("books a fill that landed before the stop", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      heldWithSell(state, "sell-1");
      internals._state = state;
      closesAs(internals, {
        "sell-1": {
          closed: true,
          order: {
            id: "sell-1",
            side: "sell",
            status: "filled",
            filled_quantity: "0.1",
            filled_amount: "10.5",
            average_fill_price: "105",
            total_fee: "0",
            fee_currency: "USD",
          } as OrderDetails,
        },
      });

      // when
      await bot.shutdown();

      // then
      expect(state.stats.totalSells).toBe(1);
      expect(state.levels[0].positions).toEqual([]);
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).not.toContain("stays in the wallet");
    });

    it("keeps the grid for the next start when the system stops it", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      heldWithSell(state, "sell-1");
      internals._state = state;
      const cancelled = closesAs(internals, {});

      // when
      await bot.shutdown("pause");

      // then
      expect(cancelled).toEqual(["sell-1"]);
      expect(deleteGridState).not.toHaveBeenCalled();
      expect(saveGridState).toHaveBeenCalledWith(state);
      expect(state.stopped).toBeUndefined();
      expect(text()).toContain(
        "\u26A0 Acquired BTC remains. State saved for the next startup.",
      );
    });

    it("names a grid order replaced outside the bot", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      internals._state = state;
      closesAs(internals, {
        "buy-1": {
          closed: true,
          order: {
            id: "buy-1",
            side: "buy",
            status: "cancelled",
            reject_reason: "replaced",
            filled_quantity: "0",
          } as OrderDetails,
        },
      });

      // when
      await bot.shutdown();

      // then
      expect(text()).toContain(
        "1 order was replaced outside the bot. The replacement isn't tracked and wasn't cancelled. Check revx order open.",
      );
      expect(text()).not.toContain("Cancelled 1 order");
    });

    it("ends a dry-run grid without calling the exchange", async () => {
      // given
      const { bot, state, internals, text } = unlistedBot();
      state.config.dryRun = true;
      heldWithSell(state, "dry-sell-1");
      internals._state = state;
      const cancelled = closesAs(internals, {});

      // when
      await bot.shutdown();

      // then
      expect(cancelled).toEqual([]);
      expect(deleteGridState).toHaveBeenCalledWith("BTC-USD");
      expect(text()).toContain("Cancelled 1 order");
      expect(text()).not.toContain("stays in the wallet");
    });
  });

  it("starts no new grid once Ctrl+C was pressed", async () => {
    // given
    const { internals, placeOrder } = unlistedBot();
    (internals as unknown as { _state: GridState | null })._state = null;
    stopRequest(internals).abort();

    // when
    await (
      internals as unknown as { _initNewGrid: () => Promise<void> }
    )._initNewGrid();

    // then
    expect(
      (internals as unknown as { _state: GridState | null })._state,
    ).toBeNull();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("drops the buy it was about to send when Ctrl+C comes while it waits for its turn", async () => {
    // given
    const { state, internals, placeOrder } = unlistedBot();
    internals._state = state;
    internals._rateLimiter = {
      query: (fn: () => Promise<unknown>) => fn(),
      place: async (
        fn: () => Promise<unknown>,
        refuse?: () => Error | null,
      ) => {
        stopRequest(internals).abort();
        const refusal = refuse?.();
        if (refusal) throw refusal;
        return fn();
      },
    };

    // when
    const placed = await internals._placeBuyOrAlert(state.levels[1]);

    // then
    expect(placed).toBeNull();
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[1].pendingBuyClientOrderIds ?? []).toEqual([]);
    expect(internals._warnings.join("\n")).not.toContain("could not place");
  });

  it("waits for start-up before cancelling, so an order placed during start-up is cancelled too", async () => {
    // given
    const { state, internals, bot } = unlistedBot();
    let finishStartup!: () => void;
    internals._startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const cancels: string[] = [];
    internals._cancelUntilClosed = async (orderId: string) => {
      cancels.push(orderId);
      return {
        closed: true,
        order: {
          id: orderId,
          client_order_id: `c-${orderId}`,
          status: "cancelled",
          filled_quantity: "0",
        } as OrderDetails,
      };
    };

    // when
    const stopping = bot.shutdown();
    internals._state = state;
    state.levels[1].buyOrderIds = ["buy-late"];
    finishStartup();
    await stopping;

    // then
    expect(cancels.sort()).toEqual(["buy-1", "buy-late"]);
  });

  it("keeps a buy the main loop can't find yet, without a warning", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals } = unlistedBot();
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
    expect(state.missingSince).toEqual({ "buy-1": new Date().toISOString() });
    expect(internals._warnings.join("\n")).not.toContain("Check buy");
    expect(internals._attentionLines().join("\n")).not.toContain("not listed");
  });

  it("shows a buy as not listed yet once it has been missing for a minute", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals } = unlistedBot();
    internals._state = state;
    await internals._tick(new Decimal("99.5"));

    // when
    vi.setSystemTime(Date.now() + 61_000);
    await internals._tick(new Decimal("99.5"));

    // then
    expect(internals._attentionLines()).toContain(
      "Buy @99 not listed by the exchange yet",
    );
  });

  it("doesn't place a second first buy on a level whose buy isn't listed yet", async () => {
    // given
    const { state, internals, placeOrder } = unlistedBot();
    state.initializing = true;

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(
      placeOrder.mock.calls.map(([request]) => request.limit.price),
    ).toEqual(["99.1"]);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
  });

  it("holds a resumed buy that comes back rejected during the restart without reading it back", async () => {
    // given
    const { state, internals, placeOrder, readIds, text } = unlistedBot();
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["c-pending"];
    state.levels[0].pendingBuyQuoteSizes = { "c-pending": "10" };
    placeOrder.mockImplementation(async (request: PlaceRequest) => ({
      data: {
        venue_order_id: `${request.side}-${request.limit.price}`,
        client_order_id: request.clientOrderId,
        state: "rejected" as const,
      },
    }));

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(
      placeOrder.mock.calls.map(([request]) => request.clientOrderId),
    ).toEqual(["c-pending"]);
    expect(readIds()).not.toContain("buy-99");
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual(["c-pending"]);
    expect(text()).toContain(
      "1 order rejected or already placed, looked up by client order ID for up to 5 minutes",
    );
    expect(text()).not.toContain("not listed by the exchange");
  });

  it("keeps an order that only answers not-found during a cancel until it has been missing for five minutes", async () => {
    // given
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, internals } = unlistedBot();
    internals._state = state;
    internals._cancelUntilClosed = async () => ({ closed: true, order: null });

    // when
    const first = await internals._closeGridOrders(state, "keepTraded");
    state.missingSince = { "buy-1": minutesAgo(5) };
    const later = await internals._closeGridOrders(state, "keepTraded");

    // then
    expect(first).toMatchObject({ problems: [], unlisted: ["buy-1"] });
    expect(later).toMatchObject({ problems: [], unlisted: [] });
    expect(state.levels[0].buyOrderIds).toEqual([]);
  });

  it("holds back trailing up while an order isn't listed yet", () => {
    // given
    const { state, internals } = unlistedBot();
    state.missingSince = { "buy-1": new Date().toISOString() };
    internals._state = state;

    // when
    const unresolved = internals._hasUnresolvedPlacementIntents();

    // then
    expect(unresolved).toBe(true);
  });

  it("keeps first misses recorded under client order ids while they are pending", () => {
    // given
    const { state, internals } = unlistedBot();
    const stamp = new Date().toISOString();
    state.levels[0].pendingBuyClientOrderIds = ["c-buy"];
    state.levels[1].positions = [
      {
        id: "p1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: null,
        sellClientOrderId: "c-sell",
      },
    ];
    state.splitClientOrderId = "c-split";
    state.missingSince = {
      "buy-1": stamp,
      "c-buy": stamp,
      "c-sell": stamp,
      "c-split": stamp,
      stale: stamp,
    };

    // when
    internals._pruneMissing(state);

    // then
    expect(Object.keys(state.missingSince).sort()).toEqual([
      "buy-1",
      "c-buy",
      "c-sell",
      "c-split",
    ]);
  });

  it("forgets the first miss once the order shows up", async () => {
    // given
    const { state, internals } = unlistedBot({ active: ["sell-saved"] });
    heldWithSell(state, "sell-saved");
    state.missingSince = {
      "sell-saved": new Date(Date.now() - 60_000).toISOString(),
    };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.missingSince).toEqual({});
    expect(internals._attentionLines()).toEqual([]);
  });

  it("drops first misses of orders the grid no longer tracks", async () => {
    // given
    const { state, internals } = unlistedBot({
      orders: { "buy-1": { status: "new" } },
    });
    state.missingSince = {
      "long-gone": new Date(Date.now() - 60_000).toISOString(),
    };
    internals._state = state;

    // when
    await internals._tick(new Decimal("99.5"));

    // then
    expect(state.missingSince).toEqual({});
  });
});

describe("grid bot Telegram health", () => {
  const CONNECTION: TelegramConnection = {
    id: "conn-1",
    label: "phone",
    bot_token: "123456789:token",
    chat_id: "42",
    enabled: true,
    created_at: "2026-10-13T00:00:00Z",
    updated_at: "2026-10-13T00:00:00Z",
  };

  function telegramBot() {
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: false,
      trailingUp: false,
    });
    const telegram = bot as unknown as {
      _connections: TelegramConnection[];
      _notify: (message: string) => Promise<boolean>;
      _telegramProblem: () => string | null;
      _forgetRemovedConnections: () => void;
    };
    telegram._connections = [CONNECTION];
    return telegram;
  }

  it("shows the latest failed send until one goes through", async () => {
    // given
    const telegram = telegramBot();
    mockSendWithRetries.mockResolvedValueOnce({
      success: false,
      error: "HTTP 401: Unauthorized",
    });

    // when
    const first = await telegram._notify("first");
    const failing = telegram._telegramProblem();
    const second = await telegram._notify("second");

    // then
    expect(first).toBe(false);
    expect(failing).toBe("HTTP 401: Unauthorized");
    expect(second).toBe(true);
    expect(telegram._telegramProblem()).toBeNull();
  });

  it("forgets the failure of a connection that was removed", async () => {
    // given
    const telegram = telegramBot();
    mockSendWithRetries.mockResolvedValueOnce({
      success: false,
      error: "HTTP 401: Unauthorized",
    });
    await telegram._notify("first");

    // when
    telegram._connections = [];
    telegram._forgetRemovedConnections();
    telegram._connections = [CONNECTION];

    // then
    expect(telegram._telegramProblem()).toBeNull();
  });
});

describe("grid bot orders whose reply was lost or came back rejected", () => {
  type Request = {
    clientOrderId: string;
    side: "buy" | "sell";
    limit: { price: string; quoteSize?: string; baseSize?: string };
  };
  type Reply = "answer" | "lose" | "drop" | "reject" | "refuse";

  const RESTING = new Set(["new", "partially_filled"]);
  const PRICE = new Decimal("99.05");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function aMinuteLater() {
    vi.setSystemTime(Date.now() + 61_000);
  }

  function exchangeOrder(
    id: string,
    request: Request,
    status: Order["status"],
    overrides: Partial<Order> = {},
  ): Order {
    const quantity = request.limit.baseSize ?? "0.1";
    return {
      id,
      client_order_id: request.clientOrderId,
      symbol: "BTC/USD",
      side: request.side,
      type: "limit",
      quantity,
      filled_quantity: "0",
      leaves_quantity: RESTING.has(status) ? quantity : "0",
      price: request.limit.price,
      status,
      time_in_force: "gtc",
      execution_instructions: ["allow_taker"],
      created_date: Date.now(),
      updated_date: Date.now(),
      ...overrides,
    };
  }

  function sellRequest(clientOrderId: string): Request {
    return {
      clientOrderId,
      side: "sell",
      limit: { price: "99.1", baseSize: "0.1" },
    };
  }

  function exchangeBot(state: GridState) {
    const orders: Order[] = [];
    const unlisted = new Set<string>();
    const replies: Reply[] = [];
    let sent = 0;
    const placeOrder = vi.fn(async (request: Request) => {
      sent++;
      const reply = replies.shift() ?? "answer";
      if (reply === "drop") {
        throw new NetworkError("No reply from the exchange within 30 s.");
      }
      if (reply === "refuse") {
        throw new BadRequestError(
          `An order with the client_order_id '${request.clientOrderId}' has already been placed.`,
        );
      }
      const duplicate = orders.some(
        (order) => order.client_order_id === request.clientOrderId,
      );
      const rejected = duplicate || reply === "reject";
      const id = `${duplicate ? "twin" : "order"}-${sent}`;
      orders.push(exchangeOrder(id, request, rejected ? "rejected" : "new"));
      if (reply === "lose") {
        throw new NetworkError("No reply from the exchange within 30 s.");
      }
      return {
        data: {
          venue_order_id: id,
          client_order_id: request.clientOrderId,
          state: rejected ? ("rejected" as const) : ("new" as const),
        },
      };
    });
    const listed = () => orders.filter((order) => !unlisted.has(order.id));
    const output: string[] = [];
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 4,
        rangePct: "0.01",
        investment: "40",
        splitInvestment: false,
        intervalSec: 30,
        dryRun: false,
        reset: false,
        trailingUp: false,
      },
      {
        humanOutput: {
          write: (chunk: string) => {
            output.push(chunk);
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    );
    const internals = bot as unknown as {
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: Record<string, unknown>;
      _priceSource: { peek: () => Promise<Decimal> };
      _placementHealth: {
        rejected: (slot: string, clientOrderId: string) => number | null;
      };
      _warnings: string[];
      _attentionLines: () => string[];
      _tick: (price: Decimal) => Promise<void>;
      _placeSellOnLevel: (
        sellLevel: GridLevelState,
        position: GridLevelPosition,
      ) => Promise<void>;
      _resumePendingPlacements: () => Promise<unknown>;
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._priceSource = { peek: async () => PRICE };
    internals._client = {
      placeOrder,
      getActiveOrders: vi.fn(async () => ({
        data: listed().filter((order) => RESTING.has(order.status)),
        metadata: {},
      })),
      getHistoricalOrders: vi.fn(
        async (request: { startDate: number; endDate: number }) => ({
          data:
            request.startDate <= request.endDate
              ? listed().filter((order) => !RESTING.has(order.status))
              : [],
          metadata: {},
        }),
      ),
      getOrder: vi.fn(async (id: string) => {
        const order = listed().find((candidate) => candidate.id === id);
        if (!order) throw new NotFoundError(`Order with ID '${id}' not found.`);
        return { data: order as OrderDetails };
      }),
      getBalances: vi.fn(async () => [
        { currency: "USD", available: "1000" },
        { currency: "BTC", available: "10" },
      ]),
    };
    const warnings: string[] = [];
    const check = async () => {
      try {
        await internals._tick(PRICE);
      } finally {
        warnings.push(...internals._warnings);
      }
    };
    const sends = (side: "buy" | "sell") =>
      placeOrder.mock.calls
        .map(([request]) => request)
        .filter((request) => request.side === side)
        .map((request) => request.clientOrderId);
    const live = (side: "buy" | "sell") =>
      orders
        .filter((order) => order.side === side && RESTING.has(order.status))
        .map((order) => order.id);
    const rejections = () =>
      warnings.filter((warning) => warning.includes("rejected, retrying"));
    return {
      internals,
      orders,
      unlisted,
      replies,
      check,
      sends,
      live,
      rejections,
      text: () => stripVTControlCharacters(output.join("")),
    };
  }

  function sellState() {
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.gridPrice = "99";
    state.levels[0].buyOrderIds = [];
    const position: GridLevelPosition = {
      id: "p1",
      baseHeld: "0.1",
      fillCost: "9.9",
      slotQuote: "10",
      sellOrderId: null,
    };
    state.levels[0].positions = [position];
    return { state, position };
  }

  it("tracks a sell whose reply was lost from the next check's open orders and sends nothing more", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("lose");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    exchange.unlisted.add("order-1");
    await exchange.check();

    // when
    exchange.unlisted.delete("order-1");
    await exchange.check();

    // then
    expect(exchange.sends("sell")).toEqual([clientOrderId]);
    expect(position.sellOrderId).toBe("order-1");
    expect(position.sellClientOrderId).toBe(clientOrderId);
    expect(exchange.live("sell")).toEqual(["order-1"]);
    expect(exchange.rejections()).toEqual([]);
  });

  it("keeps the client order ID when its re-send comes back rejected and tracks the first order once listed", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("lose");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    exchange.unlisted.add("order-1");
    await exchange.check();
    aMinuteLater();
    await exchange.check();
    aMinuteLater();
    await exchange.check();
    const whileUnlisted = {
      sends: exchange.sends("sell"),
      sellOrderId: position.sellOrderId,
      sellClientOrderId: position.sellClientOrderId,
      attention: exchange.internals._attentionLines(),
    };

    // when
    exchange.unlisted.delete("order-1");
    await exchange.check();

    // then
    expect(whileUnlisted).toEqual({
      sends: [clientOrderId, clientOrderId],
      sellOrderId: null,
      sellClientOrderId: clientOrderId,
      attention: [
        "Sell @99.1 rejected or already placed, looked up once a minute",
      ],
    });
    expect(exchange.orders.map((order) => order.id)).toEqual([
      "order-1",
      "twin-2",
    ]);
    expect(position.sellOrderId).toBe("order-1");
    expect(exchange.sends("sell")).toEqual([clientOrderId, clientOrderId]);
    expect(exchange.live("sell")).toEqual(["order-1"]);
    expect(exchange.rejections()).toEqual([]);
  });

  it("waits a check after a lost reply and sends the sell again under the same ID once two lookups miss it", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("drop");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    await exchange.check();
    const afterFirstCheck = exchange.sends("sell").length;

    // when
    aMinuteLater();
    await exchange.check();

    // then
    expect(afterFirstCheck).toBe(1);
    expect(exchange.sends("sell")).toEqual([clientOrderId, clientOrderId]);
    expect(position.sellOrderId).toBe("order-2");
  });

  it("places a rejected sell again under a new client order ID only after 5 minutes, counting one rejection", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("reject");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    for (let minute = 0; minute < 4; minute++) {
      aMinuteLater();
      await exchange.check();
    }
    const withinFiveMinutes = exchange.sends("sell");

    // when
    aMinuteLater();
    await exchange.check();

    // then
    expect(withinFiveMinutes).toEqual([clientOrderId]);
    const sends = exchange.sends("sell");
    expect(sends).toHaveLength(2);
    expect(sends[1]).not.toBe(clientOrderId);
    expect(position.sellClientOrderId).toBe(sends[1]);
    expect(position.sellOrderId).toBe("order-2");
    expect(exchange.rejections()).toEqual([
      "Sell @99.1 rejected, retrying (2/3)",
    ]);
  });

  it("stops after a sell is rejected three times in a row, waiting 5 minutes after each one", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("reject", "reject", "reject");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const sendsByMinute: number[] = [];
    let failure: unknown = null;
    let stoppedAt = 0;

    // when
    for (let minute = 1; minute <= 20 && !failure; minute++) {
      aMinuteLater();
      await exchange.check().catch((err: unknown) => {
        failure = err;
        stoppedAt = minute;
      });
      sendsByMinute.push(exchange.sends("sell").length);
    }

    // then
    expect(failure).toMatchObject({
      name: "OrderRejectedError",
      side: "sell",
      price: "99.1",
    });
    expect(stoppedAt).toBe(15);
    expect(sendsByMinute).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3,
    ]);
    expect(new Set(exchange.sends("sell")).size).toBe(3);
  });

  it("waits 5 minutes from a rejected answer even when the first send went out long before", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("drop", "drop", "drop", "lose");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    const sellOrderIds: Array<string | null> = [];

    // when
    for (let minute = 1; minute <= 8; minute++) {
      aMinuteLater();
      if (minute === 8) exchange.unlisted.delete("order-4");
      await exchange.check();
      if (minute === 4) exchange.unlisted.add("order-4");
      sellOrderIds.push(position.sellOrderId);
    }

    // then
    expect(exchange.orders.map((order) => order.id)).toEqual([
      "order-4",
      "twin-5",
    ]);
    expect(new Set(exchange.sends("sell"))).toEqual(new Set([clientOrderId]));
    expect(sellOrderIds).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "order-4",
    ]);
    expect(exchange.rejections()).toEqual([]);
  });

  it("judges the 5 minutes by when the orders were read, not by when a slow lookup ends", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("lose");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;
    exchange.unlisted.add("order-1");
    await exchange.check();
    aMinuteLater();
    await exchange.check();
    for (let minute = 0; minute < 3; minute++) {
      aMinuteLater();
      await exchange.check();
    }
    const client = exchange.internals._client;
    const readHistory = client.getHistoricalOrders as (
      request: unknown,
    ) => Promise<unknown>;
    client.getHistoricalOrders = async (request: unknown) => {
      if (exchange.unlisted.delete("order-1")) {
        vi.setSystemTime(Date.now() + 120_000);
      }
      return readHistory(request);
    };

    // when
    aMinuteLater();
    await exchange.check();
    aMinuteLater();
    await exchange.check();

    // then
    expect(new Set(exchange.sends("sell"))).toEqual(new Set([clientOrderId]));
    expect(exchange.live("sell")).toEqual(["order-1"]);
    expect(position.sellOrderId).toBe("order-1");
    expect(exchange.rejections()).toEqual([]);
  });

  it("never counts the rejected copies of an order that is on the book", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("lose");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    exchange.unlisted.add("order-1");

    // when
    for (let minute = 0; minute < 4; minute++) {
      aMinuteLater();
      await exchange.check();
    }
    exchange.unlisted.delete("order-1");
    await exchange.check();

    // then
    expect(new Set(exchange.sends("sell")).size).toBe(1);
    expect(position.sellOrderId).toBe("order-1");
    expect(exchange.rejections()).toEqual([]);
  });

  it("gives up on a client order ID the exchange calls already placed but never lists, after 5 minutes", async () => {
    // given
    const { state, position } = sellState();
    const exchange = exchangeBot(state);
    exchange.replies.push("drop", "refuse");
    await exchange.internals._placeSellOnLevel(state.levels[1], position);
    const clientOrderId = position.sellClientOrderId;

    // when
    for (let minute = 0; minute < 7; minute++) {
      aMinuteLater();
      await exchange.check();
    }

    // then
    const sends = exchange.sends("sell");
    expect(sends.slice(0, 2)).toEqual([clientOrderId, clientOrderId]);
    expect(sends).toHaveLength(3);
    expect(position.sellOrderId).toBe("order-3");
    expect(exchange.rejections()).toEqual([
      "Sell @99.1 rejected, retrying (2/3)",
    ]);
  });

  it("keeps a re-sent buy that comes back rejected and places no second buy on its level", async () => {
    // given
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.gridPrice = "99.1";
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "10" };
    const exchange = exchangeBot(state);
    exchange.orders.push(
      exchangeOrder(
        "first",
        {
          clientOrderId: "lost",
          side: "buy",
          limit: { price: "99", baseSize: "0.1" },
        },
        "new",
      ),
    );
    exchange.unlisted.add("first");
    await exchange.check();
    aMinuteLater();
    await exchange.check();
    aMinuteLater();
    await exchange.check();
    const whileUnlisted = {
      sends: exchange.sends("buy"),
      pending: [...(state.levels[0].pendingBuyClientOrderIds ?? [])],
      tracked: [...state.levels[0].buyOrderIds],
    };

    // when
    exchange.unlisted.delete("first");
    await exchange.check();

    // then
    expect(whileUnlisted).toEqual({
      sends: ["lost"],
      pending: ["lost"],
      tracked: [],
    });
    expect(state.levels[0].buyOrderIds).toEqual(["first"]);
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(exchange.sends("buy")).toEqual(["lost"]);
    expect(exchange.rejections()).toEqual([]);
  });

  it("places a new buy only 5 minutes after the exchange calls its re-send already placed", async () => {
    // given
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.gridPrice = "99.1";
    state.levels[0].buyOrderIds = [];
    state.levels[0].pendingBuyClientOrderIds = ["lost"];
    state.levels[0].pendingBuyQuoteSizes = { lost: "10" };
    const exchange = exchangeBot(state);
    exchange.replies.push("refuse");
    const sendsByMinute: number[] = [];

    // when
    await exchange.check();
    for (let minute = 1; minute <= 6; minute++) {
      aMinuteLater();
      await exchange.check();
      sendsByMinute.push(exchange.sends("buy").length);
    }

    // then
    expect(sendsByMinute).toEqual([1, 1, 1, 1, 1, 2]);
    const sends = exchange.sends("buy");
    expect(sends[0]).toBe("lost");
    expect(sends[1]).not.toBe("lost");
    expect(state.levels[0].buyOrderIds).toEqual(["order-2"]);
    expect(state.levels[0].buyOrderQuoteSizes).toEqual({ "order-2": "10" });
    expect(exchange.rejections()).toEqual(["Buy @99 rejected, retrying (2/3)"]);
  });

  it("gives a leftover buy's amount back to its slot when giving up on it stops the grid", async () => {
    // given
    const state = makeState();
    state.createdAt = new Date(Date.now() - 60_000).toISOString();
    state.gridPrice = "99.1";
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "p1",
        baseHeld: "0.06",
        fillCost: "6",
        slotQuote: "6",
        sellOrderId: "sell-1",
        sellBaseSize: "0.06",
      },
    ];
    state.levels[0].pendingBuyClientOrderIds = ["leftover"];
    state.levels[0].pendingBuyQuoteSizes = { leftover: "4" };
    state.usedClientOrderIds = ["leftover"];
    state.missingSince = {
      leftover: new Date(Date.now() - 6 * 60_000).toISOString(),
    };
    const exchange = exchangeBot(state);
    exchange.orders.push(
      exchangeOrder(
        "sell-1",
        {
          clientOrderId: "sell-1-client",
          side: "sell",
          limit: { price: "99.1", baseSize: "0.06" },
        },
        "new",
      ),
    );
    exchange.internals._placementHealth.rejected("buy:0", "earlier-1");
    exchange.internals._placementHealth.rejected("buy:0", "earlier-2");

    // when
    const failure = await exchange.check().catch((err: unknown) => err);

    // then
    expect(failure).toMatchObject({ name: "OrderRejectedError", side: "buy" });
    expect(state.levels[0].pendingBuyClientOrderIds).toEqual([]);
    expect(state.levels[0].positions[0].slotQuote).toBe("10");
    expect(exchange.sends("buy")).toEqual([]);
  });

  it("does not send a client order ID the exchange already used again after a restart", async () => {
    // given
    const { state, position } = sellState();
    position.sellClientOrderId = "lost-sell";
    position.sellBaseSize = "0.1";
    state.usedClientOrderIds = ["lost-sell"];
    state.missingSince = { "lost-sell": new Date().toISOString() };
    const exchange = exchangeBot(state);

    // when
    await exchange.internals._resumePendingPlacements();
    aMinuteLater();
    await exchange.check();
    aMinuteLater();
    await exchange.check();

    // then
    expect(exchange.sends("sell")).toEqual([]);
    expect(position.sellClientOrderId).toBe("lost-sell");
    expect(position.sellOrderId).toBeNull();
  });

  it("tracks the filled first order over a rejected copy with the same client order ID", async () => {
    // given
    const { state, position } = sellState();
    position.sellClientOrderId = "lost-sell";
    position.sellBaseSize = "0.1";
    const exchange = exchangeBot(state);
    exchange.orders.push(
      exchangeOrder("twin", sellRequest("lost-sell"), "rejected"),
      exchangeOrder("first", sellRequest("lost-sell"), "filled", {
        filled_quantity: "0.1",
      }),
    );

    // when
    await exchange.internals._resumePendingPlacements();

    // then
    expect(position.sellOrderId).toBe("first");
    expect(exchange.sends("sell")).toEqual([]);
  });

  it("swaps a tracked sell that reads as rejected for the open order with its client order ID", async () => {
    // given
    const { state, position } = sellState();
    position.sellOrderId = "twin";
    position.sellClientOrderId = "lost-sell";
    position.sellBaseSize = "0.1";
    const exchange = exchangeBot(state);
    exchange.orders.push(
      exchangeOrder("first", sellRequest("lost-sell"), "new"),
      exchangeOrder("twin", sellRequest("lost-sell"), "rejected"),
    );

    // when
    await exchange.check();

    // then
    expect(position.sellOrderId).toBe("first");
    expect(exchange.sends("sell")).toEqual([]);
    expect(exchange.rejections()).toEqual([]);
  });

  it("swaps a saved sell that reads as rejected at start-up without placing another", async () => {
    // given
    const { state, position } = sellState();
    position.sellOrderId = "twin";
    position.sellClientOrderId = "lost-sell";
    position.sellBaseSize = "0.1";
    const exchange = exchangeBot(state);
    exchange.orders.push(
      exchangeOrder("first", sellRequest("lost-sell"), "new"),
      exchangeOrder("twin", sellRequest("lost-sell"), "rejected"),
    );

    // when
    await exchange.internals._reconcileAndInit(state);
    const sentAtStartUp = exchange.sends("sell");
    await exchange.check();

    // then
    expect(sentAtStartUp).toEqual([]);
    expect(exchange.text()).toContain(
      "1 order rejected or already placed, looked up by client order ID for up to 5 minutes",
    );
    expect(position.sellOrderId).toBe("first");
    expect(exchange.sends("sell")).toEqual([]);
    expect(exchange.live("sell")).toEqual(["first"]);
  });
});
