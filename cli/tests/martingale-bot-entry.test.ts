import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import type { CurrencyPair, OrderDetails } from "@revolut/revolut-x-api";
import { ForegroundMartingaleBot } from "../src/engine/martingale-bot.js";
import {
  saveMartingaleState,
  type MartingaleState,
} from "../src/db/martingale-store.js";

vi.mock("../src/db/martingale-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/martingale-store.js")>()),
  saveMartingaleState: vi.fn(),
  deleteMartingaleState: vi.fn(),
}));

vi.mock("../src/db/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/store.js")>()),
  loadConnections: () => [],
}));

const PAIR_INFO: CurrencyPair = {
  base: "ETH",
  quote: "USD",
  base_step: "0.00000001",
  quote_step: "0.01",
  min_order_size: "0.0001",
  max_order_size: "1000",
  min_order_size_quote: "1",
  slippage: 0,
  status: "active",
};

const REFERENCE_PRICE = "2520.33";

const FULL_FILL: Partial<OrderDetails> = {
  status: "filled",
  filled_quantity: "0.02638955",
  filled_amount: "66.66",
  average_fill_price: "2526",
  total_fee: "0.00002375",
  fee_currency: "ETH",
};

const PARTIAL_FILL: Partial<OrderDetails> = {
  status: "partially_filled",
  filled_quantity: "0.01",
  filled_amount: "25.26",
  average_fill_price: "2526",
  total_fee: "0.000009",
  fee_currency: "ETH",
};

interface PlacedOrder {
  side: string;
  market?: { quoteSize: string };
  limit?: { price: string; quoteSize?: string; baseSize?: string };
}

function makeClient(
  entryPolls: Partial<OrderDetails>[],
  activeOrderIds: string[] = [],
) {
  const polls = [...entryPolls];
  let sequence = 0;
  const placeOrder = vi.fn(async (params: PlacedOrder) => ({
    data: {
      venue_order_id: params.market ? "entry" : `limit-${++sequence}`,
      state: "new",
    },
  }));
  const getOrder = vi.fn(async (orderId: string) => ({
    data: {
      id: orderId,
      ...(polls.length > 1 ? polls.shift() : polls[0]),
    } as OrderDetails,
  }));
  const getActiveOrders = vi.fn(async () => ({
    data: activeOrderIds.map((id) => ({ id })),
    metadata: {},
  }));
  const getBalances = vi.fn(async () => [
    { currency: "USD", available: "100000" },
  ]);
  return { placeOrder, getOrder, getActiveOrders, getBalances };
}

type FakeClient = ReturnType<typeof makeClient>;

interface Internals {
  _pairInfo: CurrencyPair;
  _client: FakeClient;
  _priceSource: { peek: () => Promise<Decimal> };
  _state: MartingaleState | null;
  _running: boolean;
  _lifecycle: string;
  _initNewCycle: () => Promise<void>;
  _resetCycle: () => void;
  _tick: (price: Decimal) => Promise<void>;
}

function makeBot(client: FakeClient, referencePrice = REFERENCE_PRICE) {
  const bot = new ForegroundMartingaleBot({
    pair: "ETH-USD",
    priceDeviation: "0.01",
    safetyOrderVolumeScale: "2",
    maxSafetyOrders: 3,
    takeProfit: "0.01",
    stopLoss: "0.08",
    investment: "1000",
    intervalSec: 10,
    dryRun: false,
    reset: false,
  });
  const internals = bot as unknown as Internals;
  internals._pairInfo = PAIR_INFO;
  internals._client = client;
  internals._priceSource = { peek: async () => new Decimal(referencePrice) };
  internals._running = true;
  return internals;
}

function limitBuyPrices(client: FakeClient): string[] {
  return client.placeOrder.mock.calls
    .map(([params]) => params)
    .filter((params) => params.side === "buy" && params.limit)
    .map((params) => params.limit!.price);
}

function takeProfitOrders(client: FakeClient): PlacedOrder[] {
  return client.placeOrder.mock.calls
    .map(([params]) => params)
    .filter((params) => params.side === "sell");
}

describe("martingale market entry", () => {
  it("anchors the safety orders and stop-loss to the average fill price", async () => {
    // given
    const client = makeClient([FULL_FILL]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    const state = bot._state!;
    expect(limitBuyPrices(client)).toEqual(["2500.74", "2475.73", "2450.97"]);
    expect(state.stopLossPrice).toBe("2323.92");
    expect(state.initialBuyPrice).toBe("2526");
    expect(state.levels[0].price).toBe("2526");
    expect(state.tradeLog[0].price).toBe("2526");
  });

  it("anchors to filled amount over filled quantity when the average fill price is missing", async () => {
    // given
    const client = makeClient([
      {
        ...FULL_FILL,
        average_fill_price: undefined,
        price: "2600",
        filled_quantity: "0.0264",
      },
    ]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    expect(bot._state!.initialBuyPrice).toBe("2525");
    expect(limitBuyPrices(client)[0]).toBe("2499.75");
  });

  it("stops without placing safety orders or a take-profit when the entry is only partially filled", async () => {
    // given
    const client = makeClient([PARTIAL_FILL]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    const state = bot._state!;
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(bot._running).toBe(false);
    expect(bot._lifecycle).toBe("stopped");
    expect(state.inPosition).toBe(true);
    expect(state.totalQty).toBe("0.009991");
    expect(state.totalCost).toBe("25.26");
    expect(state.tpOrderId).toBeNull();
    expect(state.levels.every((level) => level.buyOrderIds.length === 0)).toBe(
      true,
    );
    expect(state.stopLossPrice).toBe("2323.92");
    expect(saveMartingaleState).toHaveBeenCalledWith(state);
  });

  it("keeps waiting while a partially filled entry is still active", async () => {
    // given
    const client = makeClient([PARTIAL_FILL, FULL_FILL], ["entry"]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    expect(bot._running).toBe(true);
    expect(limitBuyPrices(client)).toHaveLength(3);
    expect(takeProfitOrders(client)).toHaveLength(1);
  });

  it("fails the entry immediately when the market order dies without a fill", async () => {
    // given
    const client = makeClient([
      { status: "cancelled", filled_quantity: "0", filled_amount: "0" },
    ]);
    const bot = makeBot(client);

    // when
    const init = bot._initNewCycle();

    // then
    await expect(init).rejects.toThrow(
      /Failed to place market entry.*cancelled/,
    );
    expect(limitBuyPrices(client)).toHaveLength(0);
  });

  it("anchors a new cycle after a take-profit to that cycle's own fill", async () => {
    // given
    const bot = makeBot(makeClient([FULL_FILL]));
    await bot._initNewCycle();
    bot._resetCycle();
    const client = makeClient([
      { ...FULL_FILL, average_fill_price: "2600", filled_amount: "66.66" },
    ]);
    bot._client = client;

    // when
    await bot._tick(new Decimal("2590"));

    // then
    expect(limitBuyPrices(client)).toEqual(["2574", "2548.26", "2522.77"]);
    expect(bot._state!.stopLossPrice).toBe("2392");
    expect(bot._state!.initialBuyPrice).toBe("2600");
  });

  it("stops a new cycle whose entry is only partially filled", async () => {
    // given
    const bot = makeBot(makeClient([FULL_FILL]));
    await bot._initNewCycle();
    bot._resetCycle();
    const client = makeClient([PARTIAL_FILL]);
    bot._client = client;

    // when
    await bot._tick(new Decimal(REFERENCE_PRICE));

    // then
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(takeProfitOrders(client)).toHaveLength(0);
    expect(bot._running).toBe(false);
    expect(bot._state!.inPosition).toBe(true);
  });
});
