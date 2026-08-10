import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import type { CurrencyPair } from "@revolut/revolut-x-api";
import { ForegroundGridBot } from "../src/engine/grid-bot.js";
import {
  deleteGridState,
  saveGridState,
  type GridState,
} from "../src/db/grid-store.js";

vi.mock("../src/db/grid-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/grid-store.js")>()),
  saveGridState: vi.fn(),
  deleteGridState: vi.fn(),
}));

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
      ) => Promise<{ base: Decimal; amount: Decimal; fee: Decimal }>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, getActiveOrders, placeOrder };

    // when
    const result = await internals._executeSplitMarketBuy(new Decimal("20"));

    // then
    expect(result.base.toString()).toBe("0.2");
    expect(result.amount.toString()).toBe("20");
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

  it("preserves unsold base dust and its cost basis after a sell fill", async () => {
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
    expect(state.levels[0].positions).toEqual([
      expect.objectContaining({
        id: "position-1",
        baseHeld: "0.0009",
        fillCost: "0.09",
        sellOrderId: null,
      }),
    ]);
    expect(state.stats.realizedPnl).toBe("0.1");
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

  it("reuses a pending buy client order id during runtime recovery", async () => {
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
      _replaceGridBuy: (level: GridState["levels"][number]) => Promise<void>;
    };
    internals._state = state;
    internals._client = { placeOrder };

    // when
    await internals._replaceGridBuy(level);

    // then
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
      _awaitOrderFill: (
        orderId: string,
        timeoutMs: number,
      ) => Promise<typeof order>;
    };
    internals._client = { getOrder, getActiveOrders };

    // when
    const result = internals._awaitOrderFill("partial-market", 10);

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
      _triggerStopLoss: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {};
    internals._notify = notify;

    // when
    await internals._triggerStopLoss(new Decimal("80"));
    const message = String(notify.mock.calls[0][0]);

    // then
    expect(message).toContain("Realized P&L: -$2.00");
    expect(message).not.toContain("$-");
  });

  it("finishes a pending stop-loss before normal reconciliation", async () => {
    // given
    const state = makeState();
    state.stopLossClientOrderId = "pending-stop-loss";
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
    const internals = bot as unknown as {
      _pairInfo: CurrencyPair;
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _priceSource: { peek: () => Promise<Decimal> };
      _reconcileAndInit: (savedState: GridState) => Promise<void>;
    };
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._priceSource = { peek: async () => new Decimal("90") };

    // when
    await internals._reconcileAndInit(state);

    // then
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "pending-stop-loss" }),
    );
    expect(state.stopLossClientOrderId).toBeUndefined();
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

  it("preserves held positions when stop-loss liquidation fails", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: null,
      },
    ];
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
        placeOrder: () => Promise<never>;
        cancelOrder: () => Promise<void>;
      };
      _triggerStopLoss: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder: vi.fn(async () => {
        throw new Error("sell failed");
      }),
      cancelOrder: vi.fn(async () => undefined),
    };

    // when
    await internals._triggerStopLoss(new Decimal("80"));

    // then
    expect(state.levels[0].positions).toHaveLength(1);
    expect(state.levels[0].positions[0].baseHeld).toBe("0.1");
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

  it("persists a partial stop-loss fill before reporting", async () => {
    // given
    vi.mocked(saveGridState).mockClear();
    const savedSnapshots: GridState[] = [];
    vi.mocked(saveGridState).mockImplementation((savedState) => {
      savedSnapshots.push(structuredClone(savedState));
    });
    const state = makeState();
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
      data: { venue_order_id: "partial-stop-loss" },
    }));
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "cancelled",
        filled_quantity: "0.04",
        filled_amount: "3.6",
        total_fee: "0",
        fee_currency: "USD",
      },
    }));
    const flush = vi.fn(async () => {
      throw new Error("report failed");
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
      _client: { getOrder: typeof getOrder; placeOrder: typeof placeOrder };
      _statusReporter: {
        flush: typeof flush;
        snapshot: () => [];
      };
      _triggerStopLoss: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { getOrder, placeOrder };
    internals._statusReporter = { flush, snapshot: () => [] };

    // when
    const result = internals._triggerStopLoss(new Decimal("90"));

    // then
    await expect(result).rejects.toThrow("report failed");
    expect(
      savedSnapshots.some(
        (snapshot) =>
          snapshot.levels[0].positions[0]?.baseHeld === "0.06" &&
          snapshot.stopLossClientOrderId !== undefined,
      ),
    ).toBe(true);
  });

  it("does not submit an undersized runtime stop-loss liquidation", async () => {
    // given
    const state = makeState();
    state.levels[0].buyOrderIds = [];
    state.levels[0].positions = [
      {
        id: "dust-position",
        baseHeld: "0.0009",
        fillCost: "0.09",
        sellOrderId: null,
      },
    ];
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
      _state: GridState;
      _pairInfo: CurrencyPair;
      _client: { placeOrder: typeof placeOrder };
      _triggerStopLoss: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = { placeOrder };

    // when
    await internals._triggerStopLoss(new Decimal("90"));

    // then
    expect(placeOrder).not.toHaveBeenCalled();
    expect(state.levels[0].positions).toHaveLength(1);
  });

  it("preserves order ids when stop-loss cancellation fails", async () => {
    // given
    const state = makeState();
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
        placeOrder: () => Promise<never>;
        cancelOrder: () => Promise<never>;
      };
      _triggerStopLoss: (price: Decimal) => Promise<void>;
    };
    internals._state = state;
    internals._pairInfo = PAIR_INFO;
    internals._client = {
      placeOrder: vi.fn(async () => {
        throw new Error("unexpected sell");
      }),
      cancelOrder: vi.fn(async () => {
        throw new Error("cancel failed");
      }),
    };

    // when
    await internals._triggerStopLoss(new Decimal("80"));

    // then
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
  });

  it("aborts reset and preserves any order whose cancellation fails", async () => {
    // given
    const state = makeState();
    const cancelOrder = vi.fn(async (orderId: string) => {
      if (orderId === "buy-1") {
        throw new Error("cancel failed");
      }
    });
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
      reset: true,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _client: { cancelOrder: typeof cancelOrder; getOrder: typeof getOrder };
      _cancelTrackedOrdersForReset: (savedState: GridState) => Promise<void>;
    };
    internals._client = { cancelOrder, getOrder };

    // when
    const result = internals._cancelTrackedOrdersForReset(state);

    // then
    await expect(result).rejects.toThrow(/reset.*cancellation.*failed/i);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
  });

  it("refuses reset while the grid owns acquired base", async () => {
    // given
    const state = makeState();
    state.levels[0].positions = [
      {
        id: "position-1",
        baseHeld: "0.1",
        fillCost: "10",
        sellOrderId: "sell-1",
      },
    ];
    const cancelOrder = vi.fn(async () => undefined);
    const bot = new ForegroundGridBot({
      pair: "BTC-USD",
      levels: 4,
      rangePct: "0.01",
      investment: "40",
      splitInvestment: false,
      intervalSec: 30,
      dryRun: false,
      reset: true,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _client: { cancelOrder: typeof cancelOrder };
      _cancelTrackedOrdersForReset: (savedState: GridState) => Promise<void>;
    };
    internals._client = { cancelOrder };

    // when
    const result = internals._cancelTrackedOrdersForReset(state);

    // then
    await expect(result).rejects.toThrow(/reset.*acquired base/i);
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(state.levels[0].positions[0].sellOrderId).toBe("sell-1");
  });

  it("aborts reset when a cancelled order has a partial fill", async () => {
    // given
    const state = makeState();
    const cancelOrder = vi.fn(async () => undefined);
    const getOrder = vi.fn(async (orderId: string) => ({
      data: {
        id: orderId,
        status: "cancelled",
        filled_quantity: "0.01",
        filled_amount: "1",
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
      reset: true,
      trailingUp: false,
    });
    const internals = bot as unknown as {
      _client: { cancelOrder: typeof cancelOrder; getOrder: typeof getOrder };
      _cancelTrackedOrdersForReset: (savedState: GridState) => Promise<void>;
    };
    internals._client = { cancelOrder, getOrder };

    // when
    const result = internals._cancelTrackedOrdersForReset(state);

    // then
    await expect(result).rejects.toThrow(/executed.*must be reconciled/i);
    expect(state.levels[0].buyOrderIds).toEqual(["buy-1"]);
  });

  it("keeps persisted state on shutdown while acquired base remains", async () => {
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
    expect(deleteGridState).not.toHaveBeenCalled();
    expect(saveGridState).toHaveBeenCalledWith(state);
    expect(state.levels[0].positions[0]).toEqual(
      expect.objectContaining({
        baseHeld: "0.1",
        sellOrderId: null,
        sellBaseSize: undefined,
        sellClientOrderId: undefined,
      }),
    );
  });

  it("keeps persisted state on shutdown while a split buy is in flight", async () => {
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
    const internals = bot as unknown as {
      _state: GridState;
      _client: Record<string, never>;
    };
    internals._state = state;
    internals._client = {};

    // when
    await bot.shutdown();

    // then
    expect(deleteGridState).not.toHaveBeenCalled();
    expect(saveGridState).toHaveBeenCalledWith(state);
    expect(state.splitOrderId).toBe("split-order-1");
    expect(state.splitClientOrderId).toBe("split-client-1");
  });
});
