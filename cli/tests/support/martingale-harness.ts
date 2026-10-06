import { vi } from "vitest";
import { Decimal } from "decimal.js";
import type { CurrencyPair, OrderDetails } from "@revolut/revolut-x-api";
import { ForegroundMartingaleBot } from "../../src/engine/martingale-bot.js";
import type { MartingaleState } from "../../src/db/martingale-store.js";

export const PAIR_INFO: CurrencyPair = {
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

export const REFERENCE_PRICE = "2520.33";

export const FULL_FILL: Partial<OrderDetails> = {
  status: "filled",
  filled_quantity: "0.02638955",
  filled_amount: "66.66",
  average_fill_price: "2526",
  total_fee: "0.00002375",
  fee_currency: "ETH",
};

export const PARTIAL_FILL: Partial<OrderDetails> = {
  status: "partially_filled",
  filled_quantity: "0.01",
  filled_amount: "25.26",
  average_fill_price: "2526",
  total_fee: "0.000009",
  fee_currency: "ETH",
};

export interface PlacedOrder {
  side: string;
  clientOrderId?: string;
  market?: { quoteSize?: string; baseSize?: string };
  limit?: { price: string; quoteSize?: string; baseSize?: string };
}

export function makeClient(
  orderPolls: Partial<OrderDetails>[],
  activeOrderIds: string[] = [],
  placementErrors: (Error | null)[] = [],
) {
  const polls = [...orderPolls];
  const errors = [...placementErrors];
  let marketSequence = 0;
  let limitSequence = 0;
  const placeOrder = vi.fn(async (params: PlacedOrder) => {
    const error = errors.shift();
    if (error) throw error;
    return {
      data: {
        venue_order_id: params.market
          ? `market-${++marketSequence}`
          : `limit-${++limitSequence}`,
        state: "new",
      },
    };
  });
  const getOrder = vi.fn(async (orderId: string) => ({
    data: {
      id: orderId,
      ...(polls.length > 1 ? polls.shift() : polls[0]),
    } as OrderDetails,
  }));
  const cancelOrder = vi.fn(async () => undefined);
  const getActiveOrders = vi.fn(async () => ({
    data: activeOrderIds.map((id) => ({ id })),
    metadata: {},
  }));
  const getBalances = vi.fn(async () => [
    { currency: "USD", available: "100000" },
  ]);
  return { placeOrder, getOrder, cancelOrder, getActiveOrders, getBalances };
}

export type FakeClient = ReturnType<typeof makeClient>;

export interface Internals {
  _pairInfo: CurrencyPair;
  _client: FakeClient;
  _priceSource: { peek: () => Promise<Decimal> };
  _state: MartingaleState | null;
  _running: boolean;
  _lifecycle: string;
  _initNewCycle: () => Promise<void>;
  _reconcileAndInit: (savedState: MartingaleState) => Promise<void>;
  _resetCycle: () => void;
  _tick: (price: Decimal) => Promise<void>;
  _notify: (message: string) => void;
  _notifyAndWait: (message: string) => Promise<void>;
}

export function makeBot(client: FakeClient, referencePrice = REFERENCE_PRICE) {
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

export function limitBuyPrices(client: FakeClient): string[] {
  return client.placeOrder.mock.calls
    .map(([params]) => params)
    .filter((params) => params.side === "buy" && params.limit)
    .map((params) => params.limit!.price);
}

export function takeProfitOrders(client: FakeClient): PlacedOrder[] {
  return client.placeOrder.mock.calls
    .map(([params]) => params)
    .filter((params) => params.side === "sell" && params.limit);
}

export function marketSells(client: FakeClient): PlacedOrder[] {
  return client.placeOrder.mock.calls
    .map(([params]) => params)
    .filter((params) => params.side === "sell" && params.market);
}
