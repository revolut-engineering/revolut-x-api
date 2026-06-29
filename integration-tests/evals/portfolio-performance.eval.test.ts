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

// YTD orders (~180 days): BTC +2500 USD, ETH +2000 USD, SOL +200 USD → total ~+4700 USD
const YTD_ORDERS = [
  {
    ...ORDER_BASE,
    id: "ytd-btc-buy",
    client_order_id: "cli-ytd-btc-buy",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "0.5",
    filled_quantity: "0.5",
    filled_amount: "45000",
    price: "90000",
    average_fill_price: "90000",
    status: "filled",
    created_date: now - 180 * DAY_MS,
    updated_date: now - 180 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ytd-btc-sell",
    client_order_id: "cli-ytd-btc-sell",
    symbol: "BTC-USD",
    side: "sell",
    quantity: "0.5",
    filled_quantity: "0.5",
    filled_amount: "47500",
    price: "95000",
    average_fill_price: "95000",
    status: "filled",
    created_date: now - 120 * DAY_MS,
    updated_date: now - 120 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ytd-eth-buy",
    client_order_id: "cli-ytd-eth-buy",
    symbol: "ETH-USD",
    side: "buy",
    quantity: "5",
    filled_quantity: "5",
    filled_amount: "16000",
    price: "3200",
    average_fill_price: "3200",
    status: "filled",
    created_date: now - 150 * DAY_MS,
    updated_date: now - 150 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ytd-eth-sell",
    client_order_id: "cli-ytd-eth-sell",
    symbol: "ETH-USD",
    side: "sell",
    quantity: "5",
    filled_quantity: "5",
    filled_amount: "18000",
    price: "3600",
    average_fill_price: "3600",
    status: "filled",
    created_date: now - 60 * DAY_MS,
    updated_date: now - 60 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ytd-sol-buy",
    client_order_id: "cli-ytd-sol-buy",
    symbol: "SOL-USD",
    side: "buy",
    quantity: "20",
    filled_quantity: "20",
    filled_amount: "4000",
    price: "200",
    average_fill_price: "200",
    status: "filled",
    created_date: now - 90 * DAY_MS,
    updated_date: now - 90 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ytd-sol-sell",
    client_order_id: "cli-ytd-sol-sell",
    symbol: "SOL-USD",
    side: "sell",
    quantity: "20",
    filled_quantity: "20",
    filled_amount: "4200",
    price: "210",
    average_fill_price: "210",
    status: "filled",
    created_date: now - 15 * DAY_MS,
    updated_date: now - 15 * DAY_MS,
  },
];

// 3-month orders (~90 days): BTC +800 USD, ETH +300 USD → total ~+1100 USD
const THREE_MONTH_ORDERS = [
  {
    ...ORDER_BASE,
    id: "3m-btc-buy",
    client_order_id: "cli-3m-btc-buy",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "0.2",
    filled_quantity: "0.2",
    filled_amount: "18400",
    price: "92000",
    average_fill_price: "92000",
    status: "filled",
    created_date: now - 85 * DAY_MS,
    updated_date: now - 85 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "3m-btc-sell",
    client_order_id: "cli-3m-btc-sell",
    symbol: "BTC-USD",
    side: "sell",
    quantity: "0.2",
    filled_quantity: "0.2",
    filled_amount: "19200",
    price: "96000",
    average_fill_price: "96000",
    status: "filled",
    created_date: now - 10 * DAY_MS,
    updated_date: now - 10 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "3m-eth-buy",
    client_order_id: "cli-3m-eth-buy",
    symbol: "ETH-USD",
    side: "buy",
    quantity: "3",
    filled_quantity: "3",
    filled_amount: "10200",
    price: "3400",
    average_fill_price: "3400",
    status: "filled",
    created_date: now - 80 * DAY_MS,
    updated_date: now - 80 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "3m-eth-sell",
    client_order_id: "cli-3m-eth-sell",
    symbol: "ETH-USD",
    side: "sell",
    quantity: "3",
    filled_quantity: "3",
    filled_amount: "10500",
    price: "3500",
    average_fill_price: "3500",
    status: "filled",
    created_date: now - 5 * DAY_MS,
    updated_date: now - 5 * DAY_MS,
  },
];

// Past-month orders: BTC buy then sell → +200 USD realised
const MONTH_ORDERS = [
  {
    ...ORDER_BASE,
    id: "1m-btc-buy",
    client_order_id: "cli-1m-btc-buy",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "0.1",
    filled_quantity: "0.1",
    filled_amount: "9400",
    price: "94000",
    average_fill_price: "94000",
    status: "filled",
    created_date: now - 28 * DAY_MS,
    updated_date: now - 28 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "1m-btc-sell",
    client_order_id: "cli-1m-btc-sell",
    symbol: "BTC-USD",
    side: "sell",
    quantity: "0.1",
    filled_quantity: "0.1",
    filled_amount: "9600",
    price: "96000",
    average_fill_price: "96000",
    status: "filled",
    created_date: now - 7 * DAY_MS,
    updated_date: now - 7 * DAY_MS,
  },
];

describe("portfolio performance — P&L and return queries", () => {
  defineEval({
    name: "portfolio-performance-ytd",
    description:
      "YTD performance question → get_historical_orders with start_date at or near beginning of the year; P&L computed per-symbol.",
    failureModes: ["LLM Calculation"],
    granularity: "End-to-End",
    workflow: "Account - Portfolio Performance",
    prompt: "How has my portfolio performed this year?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: YTD_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.callsToolWithArgs("get_historical_orders", {
        order_states: ["filled", "partially_filled"],
      }),
      {
        name: "start_date reaches back to roughly the start of the year (~150-365 days)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const args = call.args as { start_date?: string };
          if (!args.start_date) return false;
          const startMs = Date.parse(args.start_date);
          if (Number.isNaN(startMs)) return false;
          const days = (Date.now() - startMs) / DAY_MS;
          return days >= 150 && days <= 400;
        },
      },
      a.judge({
        name: "summarises YTD realised P&L per symbol; does not fabricate unrealised gains",
        criterion:
          "Pass if: the answer summarises realised P&L from the order data broken down by symbol (BTC, ETH, SOL) and does not invent unrealised gains or portfolio valuations beyond what the tool returned. " +
          "Fail if: any P&L figure is wrong by more than 10%, gains are extrapolated beyond filled trades, or the answer fabricates a portfolio value or percentage return not derivable from filled_amount fields.",
      }),
    ],
  });

  defineEval({
    name: "portfolio-performance-3-months",
    description:
      "3-month performance question → get_historical_orders with ~90-day window; reports realised P&L.",
    failureModes: ["LLM Calculation"],
    granularity: "End-to-End",
    workflow: "Account - Portfolio Performance",
    prompt: "How has my portfolio performed over the last 3 months on Revolut X?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: THREE_MONTH_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.callsToolWithArgs("get_historical_orders", {
        order_states: ["filled", "partially_filled"],
      }),
      {
        name: "start_date covers roughly 3 months (75-120 days ago)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const args = call.args as { start_date?: string };
          if (!args.start_date) return false;
          const startMs = Date.parse(args.start_date);
          if (Number.isNaN(startMs)) return false;
          const days = (Date.now() - startMs) / DAY_MS;
          return days >= 75 && days <= 120;
        },
      },
      a.judge({
        name: "reports ~1100 USD total realised P&L from BTC and ETH trades; no fabrication",
        criterion:
          "Pass if: the answer reports approximately 1,100 USD total realised P&L (BTC ~+800 USD, ETH ~+300 USD) and does not invent figures beyond the filled_amount data. " +
          "Fail if: any total is wrong by more than 10%, unrealised gains are invented, or the answer fabricates a return percentage not derivable from the order data.",
      }),
    ],
  });

  defineEval({
    name: "portfolio-twr-past-month",
    description:
      "TWR question for past month → agent should report realised P&L from orders OR explicitly acknowledge that true time-weighted return requires portfolio valuations not available via this API; must not fabricate a TWR percentage.",
    failureModes: ["LLM Calculation", "Hallucination"],
    granularity: "End-to-End",
    workflow: "Account - Portfolio Performance",
    prompt: "What is my time-weighted return over the past month on Revolut X?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: MONTH_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.judge({
        name: "reports realised P&L or explains TWR limitation; does not fabricate a TWR percentage",
        criterion:
          "Pass if: the answer either (a) reports the ~200 USD realised P&L from BTC trades and explicitly notes that true time-weighted return cannot be computed without portfolio valuations at each cash-flow date, or (b) reports only the realised gain without claiming it is a TWR. " +
          "Fail if: a specific TWR percentage is stated without noting the data limitation, or any figure is invented beyond what the filled_amount fields support.",
      }),
    ],
  });
});
