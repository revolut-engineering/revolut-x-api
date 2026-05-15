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
const daysAgo = (n: number) => now - n * DAY_MS;

const ORDERS = [
  {
    id: "ord-btcusd-1",
    client_order_id: "cli-btcusd-1",
    symbol: "BTC/USD",
    side: "buy",
    type: "limit",
    quantity: "0.5",
    filled_quantity: "0.5",
    filled_amount: "45000",
    leaves_quantity: "0",
    price: "90000",
    average_fill_price: "90000",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(28),
    updated_date: daysAgo(28),
  },
  {
    id: "ord-btcusd-2",
    client_order_id: "cli-btcusd-2",
    symbol: "BTC/USD",
    side: "sell",
    type: "limit",
    quantity: "0.3",
    filled_quantity: "0.3",
    filled_amount: "30000",
    leaves_quantity: "0",
    price: "100000",
    average_fill_price: "100000",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(20),
    updated_date: daysAgo(20),
  },
  {
    id: "ord-btcusd-3",
    client_order_id: "cli-btcusd-3",
    symbol: "BTC/USD",
    side: "buy",
    type: "limit",
    quantity: "0.5",
    filled_quantity: "0.15",
    filled_amount: "15000",
    leaves_quantity: "0.35",
    price: "100000",
    average_fill_price: "100000",
    status: "partially_filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(5),
    updated_date: daysAgo(5),
  },
  {
    id: "ord-etheur-1",
    client_order_id: "cli-etheur-1",
    symbol: "ETH/EUR",
    side: "buy",
    type: "limit",
    quantity: "4",
    filled_quantity: "4",
    filled_amount: "12000",
    leaves_quantity: "0",
    price: "3000",
    average_fill_price: "3000",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(22),
    updated_date: daysAgo(22),
  },
  {
    id: "ord-etheur-2",
    client_order_id: "cli-etheur-2",
    symbol: "ETH/EUR",
    side: "sell",
    type: "limit",
    quantity: "5",
    filled_quantity: "2",
    filled_amount: "8000",
    leaves_quantity: "3",
    price: "4000",
    average_fill_price: "4000",
    status: "partially_filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(10),
    updated_date: daysAgo(10),
  },
  {
    id: "ord-btcgbp-1",
    client_order_id: "cli-btcgbp-1",
    symbol: "BTC/GBP",
    side: "buy",
    type: "limit",
    quantity: "0.25",
    filled_quantity: "0.25",
    filled_amount: "20000",
    leaves_quantity: "0",
    price: "80000",
    average_fill_price: "80000",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(15),
    updated_date: daysAgo(15),
  },
  {
    id: "ord-ethusdc-1",
    client_order_id: "cli-ethusdc-1",
    symbol: "ETH/USDC",
    side: "buy",
    type: "limit",
    quantity: "10",
    filled_quantity: "10",
    filled_amount: "25000",
    leaves_quantity: "0",
    price: "2500",
    average_fill_price: "2500",
    status: "filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(18),
    updated_date: daysAgo(18),
  },
  {
    id: "ord-ethusdc-2",
    client_order_id: "cli-ethusdc-2",
    symbol: "ETH/USDC",
    side: "sell",
    type: "limit",
    quantity: "8",
    filled_quantity: "5",
    filled_amount: "15000",
    leaves_quantity: "3",
    price: "3000",
    average_fill_price: "3000",
    status: "partially_filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: daysAgo(3),
    updated_date: daysAgo(3),
  },
];

describe("trading volume — 30d grouped by quote currency", () => {
  defineEval({
    name: "trading-volume-30d-by-quote-currency",
    description:
      "Agent fetches 30d historical orders (filled + partially_filled, no symbols filter) and reports volume grouped by quote currency.",
    prompt:
      "What's my trading volume for the last 30 days grouped by quote currency (USD, EUR, GBP, USDC)?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValueOnce({
        data: ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.callsToolNTimes("get_historical_orders", 1),
      a.callsToolWithArgs("get_historical_orders", {
        order_states: ["filled", "partially_filled"],
      }),
      {
        name: "no symbols filter (queries all pairs)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const args = call.args as { symbols?: unknown };
          return (
            args.symbols === undefined ||
            (Array.isArray(args.symbols) && args.symbols.length === 0)
          );
        },
      },
      {
        name: "uses ~30 day window (relative '30d', absolute ~30d ago, or omitted for default)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const args = call.args as {
            start_date?: string;
            end_date?: string;
          };
          if (!args.start_date) return true;
          if (/^30\s*d$/i.test(args.start_date)) return true;
          const startMs = Date.parse(args.start_date);
          if (Number.isNaN(startMs)) return false;
          const days = (Date.now() - startMs) / 86_400_000;
          return days >= 25 && days <= 35;
        },
      },
      a.doesNotCallTool("get_active_orders"),
      a.finalTextContainsAll(["USD", "EUR", "GBP", "USDC"]),
      a.judge({
        name: "totals correct per quote currency, partial fills included, no fabrication",
        criterion:
          "The answer groups 30-day trading volume by quote currency and reports approximately: USD 90,000, EUR 20,000, GBP 20,000, USDC 40,000. " +
          "It correctly includes both fully filled and partially filled orders in the totals (sum of filled_amount). " +
          "It does NOT invent values not present in the tool result and does NOT confuse base/quote currencies.",
        rubric:
          "1.0 = all four totals correct (±1%) and clearly grouped by quote currency. " +
          "0.7 = all four correct but presentation is verbose or slightly ambiguous. " +
          "0.4 = one total wrong or partial fills omitted. " +
          "0.0 = multiple totals wrong, fabricated values, or base/quote confused.",
        threshold: 0.7,
      }),
    ],
  });
});
