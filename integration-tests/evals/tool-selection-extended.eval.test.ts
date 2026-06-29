import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const HOUR_MS = 60 * 60 * 1000;

const TODAY_HISTORICAL_ORDERS = [
  {
    id: "hist-today-1",
    client_order_id: "cli-hist-today-1",
    symbol: "BTC-USD",
    side: "buy",
    type: "limit",
    quantity: "0.1",
    filled_quantity: "0.1",
    filled_amount: "9500",
    leaves_quantity: "0",
    price: "95000",
    average_fill_price: "95000",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: Date.now() - 3 * HOUR_MS,
    updated_date: Date.now() - 3 * HOUR_MS,
  },
  {
    id: "hist-today-2",
    client_order_id: "cli-hist-today-2",
    symbol: "ETH-USD",
    side: "buy",
    type: "limit",
    quantity: "1",
    filled_quantity: "0.5",
    filled_amount: "1750",
    leaves_quantity: "0.5",
    price: "3500",
    average_fill_price: "3500",
    status: "partially_filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: Date.now() - HOUR_MS,
    updated_date: Date.now() - 30 * 60 * 1000,
  },
];

const TODAY_ACTIVE_ORDERS = [
  {
    id: "active-today-1",
    client_order_id: "cli-active-today-1",
    symbol: "SOL-USD",
    side: "buy",
    type: "limit",
    quantity: "10",
    filled_quantity: "0",
    leaves_quantity: "10",
    price: "150",
    status: "new",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: Date.now() - 30 * 60 * 1000,
    updated_date: Date.now() - 30 * 60 * 1000,
  },
];

const SOL_USD_PAIRS = {
  "SOL-USD": {
    base: "SOL",
    quote: "USD",
    base_step: "0.01",
    quote_step: "0.01",
    min_order_size: "0.1",
    max_order_size: "10000",
    min_order_size_quote: "10",
    status: "active",
  },
};

const SOL_CURRENCY = {
  SOL: {
    symbol: "SOL",
    name: "Solana",
    scale: 8,
    asset_type: "crypto",
    status: "active",
  },
};

const BTC_ORDER_BOOK = {
  data: {
    bids: [
      { price: "95000", quantity: "2.5", orderCount: 8 },
      { price: "94900", quantity: "4.1", orderCount: 12 },
      { price: "94800", quantity: "6.0", orderCount: 15 },
      { price: "94700", quantity: "8.5", orderCount: 20 },
      { price: "94600", quantity: "12.0", orderCount: 25 },
    ],
    asks: [
      { price: "95050", quantity: "1.8", orderCount: 6 },
      { price: "95100", quantity: "3.2", orderCount: 10 },
      { price: "95200", quantity: "5.5", orderCount: 14 },
      { price: "95300", quantity: "7.0", orderCount: 18 },
      { price: "95400", quantity: "10.5", orderCount: 22 },
    ],
  },
};

describe("tool selection — extended discrimination cases", () => {
  defineEval({
    name: "recent-placed-orders-uses-historical",
    description:
      "Orders placed today (may already be filled) → get_historical_orders; get_active_orders alone would miss filled orders.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Account - Trading History",
    prompt: "show me the orders I placed earlier today",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: TODAY_HISTORICAL_ORDERS,
        cursor: null,
        hasMore: false,
      });
      revolutXMockState.getActiveOrders.mockResolvedValue({
        data: TODAY_ACTIVE_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.judge({
        name: "includes filled orders placed today, not just currently open ones",
        criterion:
          "Pass if: the answer includes the BTC-USD order that was filled earlier today (not just the open SOL-USD order); partial fills may also be mentioned. " +
          "Fail if: only currently open orders are reported (SOL-USD only), missing the filled BTC-USD and partially-filled ETH-USD orders placed earlier.",
      }),
    ],
  });

  defineEval({
    name: "min-order-size-uses-currency-pairs",
    description:
      "Minimum order size query → get_currency_pairs (has min_order_size); get_currencies has no such field and must not be used as the answer source.",
    failureModes: ["Bad tool resolution", "Hallucination"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "what's the minimum order size for SOL-USD?",
    setup: () => {
      revolutXMockState.getCurrencyPairs.mockResolvedValueOnce(SOL_USD_PAIRS);
      revolutXMockState.getCurrencies.mockResolvedValueOnce(SOL_CURRENCY);
    },
    assertions: [
      a.callsTool("get_currency_pairs"),
      a.doesNotCallTool("get_currencies"),
      a.finalTextContainsAll(["0.1"]),
      a.judge({
        name: "cites 0.1 SOL as the minimum order size from currency pairs reference data",
        criterion:
          "Pass if: reports the minimum order size for SOL-USD as 0.1 (from the currency pairs reference) and it provides a minimum quote price." +
          "Fail if: the minimum order size is invented or omitted, or get_currencies is the only tool called (it does not carry min order size data).",
      }),
    ],
  });

  defineEval({
    name: "order-book-for-liquidity-not-tickers",
    description:
      "Liquidity / depth question → get_order_book (depth + order counts); get_tickers only gives spread without depth.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Order Book",
    prompt: "is BTC-USD liquid right now? how deep is the order book?",
    setup: () => {
      revolutXMockState.getOrderBook.mockResolvedValueOnce(BTC_ORDER_BOOK);
    },
    assertions: [
      a.callsTool("get_order_book"),
      a.doesNotCallTool("get_tickers"),
      a.judge({
        name: "reports order book depth or order counts, not just the spread",
        criterion:
          "Pass if: the answer mentions bid/ask depth (quantities available at levels), order counts, or characterises liquidity based on order book data. " +
          "Fail if: only the bid-ask spread is reported with no depth information (a tickers-level answer), or depth figures are fabricated without a tool call.",
      }),
    ],
  });
});
