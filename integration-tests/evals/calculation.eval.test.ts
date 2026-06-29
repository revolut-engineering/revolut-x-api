import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const DAY_MS = 86_400_000;
const now = Date.now();

const ORDER_BASE = {
  type: "limit" as const,
  time_in_force: "gtc" as const,
  execution_instructions: ["allow_taker"],
  leaves_quantity: "0",
};

// BTC trades: buy 1 BTC @ 90 000, sell 1 BTC @ 95 000 → realised P&L = +5 000 USD
// ETH trades: buy 10 ETH @ 3 000, sell 10 ETH @ 3 500  → realised P&L = +5 000 USD
const PNL_ORDERS = [
  {
    ...ORDER_BASE,
    id: "btc-buy-1",
    client_order_id: "cli-btc-buy-1",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "1",
    filled_quantity: "1",
    filled_amount: "90000",
    price: "90000",
    average_fill_price: "90000",
    status: "filled",
    created_date: now - 6 * DAY_MS,
    updated_date: now - 6 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "btc-sell-1",
    client_order_id: "cli-btc-sell-1",
    symbol: "BTC-USD",
    side: "sell",
    quantity: "1",
    filled_quantity: "1",
    filled_amount: "95000",
    price: "95000",
    average_fill_price: "95000",
    status: "filled",
    created_date: now - 2 * DAY_MS,
    updated_date: now - 2 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "eth-buy-1",
    client_order_id: "cli-eth-buy-1",
    symbol: "ETH-USD",
    side: "buy",
    quantity: "10",
    filled_quantity: "10",
    filled_amount: "30000",
    price: "3000",
    average_fill_price: "3000",
    status: "filled",
    created_date: now - 5 * DAY_MS,
    updated_date: now - 5 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "eth-sell-1",
    client_order_id: "cli-eth-sell-1",
    symbol: "ETH-USD",
    side: "sell",
    quantity: "10",
    filled_quantity: "10",
    filled_amount: "35000",
    price: "3500",
    average_fill_price: "3500",
    status: "filled",
    created_date: now - 1 * DAY_MS,
    updated_date: now - 1 * DAY_MS,
  },
];

// One partially-filled BTC-USD buy order where:
//   quantity * price           = 1.0 * 95 000 = 95 000  (full intended — wrong)
//   filled_quantity * price    = 0.5 * 95 000 = 47 500  (wrong field combination)
//   filled_amount              = 47 400                  (correct — use this)
const PARTIAL_ORDER = {
  ...ORDER_BASE,
  id: "partial-btc-1",
  client_order_id: "cli-partial-btc-1",
  symbol: "BTC-USD",
  side: "buy",
  quantity: "1.0",
  filled_quantity: "0.5",
  filled_amount: "47400",
  leaves_quantity: "0.5",
  price: "95000",
  average_fill_price: "94800",
  status: "partially_filled",
  created_date: now - 2 * 60 * 60 * 1000,
  updated_date: now - 60 * 60 * 1000,
};

describe("calculation — financial arithmetic on order data", () => {
  defineEval({
    name: "pnl-cross-symbol-isolation",
    description:
      "Two symbols each with a matched buy/sell pair → P&L must be computed and reported per-symbol; cross-contamination (mixing BTC and ETH figures) is a failure.",
    failureModes: ["LLM Calculation"],
    granularity: "End-to-End",
    workflow: "Account - Orders",
    prompt: "how much profit did I make this week across my BTC and ETH trades?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValueOnce({
        data: PNL_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.callsToolWithArgs("get_historical_orders", {
        order_states: ["filled", "partially_filled"],
      }),
      a.judge({
        name: "BTC and ETH P&L computed separately; no cross-symbol contamination",
        criterion:
          "Pass if: BTC profit ≈ +5 000 USD and ETH profit ≈ +5 000 USD are each stated; they may be combined into a total (+10 000 USD) only if both per-symbol figures are also present. " +
          "Fail if: the BTC P&L is attributed to ETH or vice versa, or only a combined total is given without any per-symbol breakdown, or either figure is wrong by more than 10%.",
      }),
    ],
  });

  defineEval({
    name: "partial-fill-uses-filled-amount",
    description:
      "Partially-filled order where filled_amount (47 400) differs from filled_quantity * price (47 500) and quantity * price (95 000) → agent must report filled_amount, not a derived figure.",
    failureModes: ["LLM Calculation"],
    granularity: "Tool-specific",
    workflow: "Account - Orders",
    prompt: "what was the USD value of my BTC-USD trade this week?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValueOnce({
        data: [PARTIAL_ORDER],
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.finalTextMatches(/47[,\s]?400\b/),
      a.judge({
        name: "reports filled_amount (47 400), not quantity*price (95 000) or filled_quantity*price (47 500)",
        criterion:
          "Pass if: the USD value stated is approximately 47 400 (the actual filled_amount from the tool output). " +
          "Fail if: the value given is approximately 47 500 (filled_quantity × list price), approximately 95 000 (full intended quantity × price), or any other fabricated figure that does not match the filled_amount field.",
      }),
    ],
  });
});
