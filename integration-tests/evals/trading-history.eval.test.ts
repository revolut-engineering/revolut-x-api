import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();

const ORDER_BASE = {
  type: "limit" as const,
  time_in_force: "gtc" as const,
  execution_instructions: ["allow_taker"],
};

const PNL_WEEK_ORDERS = [
  {
    ...ORDER_BASE,
    id: "ord-1",
    client_order_id: "cli-1",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "0.5",
    filled_quantity: "0.5",
    filled_amount: "45000",
    leaves_quantity: "0",
    price: "90000",
    average_fill_price: "90000",
    status: "filled",
    created_date: now - 6 * DAY_MS,
    updated_date: now - 6 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ord-2",
    client_order_id: "cli-2",
    symbol: "BTC-USD",
    side: "sell",
    quantity: "0.5",
    filled_quantity: "0.5",
    filled_amount: "47500",
    leaves_quantity: "0",
    price: "95000",
    average_fill_price: "95000",
    status: "filled",
    created_date: now - 2 * DAY_MS,
    updated_date: now - 2 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ord-3",
    client_order_id: "cli-3",
    symbol: "ETH-USD",
    side: "buy",
    quantity: "5",
    filled_quantity: "5",
    filled_amount: "15000",
    leaves_quantity: "0",
    price: "3000",
    average_fill_price: "3000",
    status: "filled",
    created_date: now - 5 * DAY_MS,
    updated_date: now - 5 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ord-4",
    client_order_id: "cli-4",
    symbol: "ETH-USD",
    side: "sell",
    quantity: "5",
    filled_quantity: "5",
    filled_amount: "17500",
    leaves_quantity: "0",
    price: "3500",
    average_fill_price: "3500",
    status: "filled",
    created_date: now - 1 * DAY_MS,
    updated_date: now - 1 * DAY_MS,
  },
  {
    ...ORDER_BASE,
    id: "ord-5",
    client_order_id: "cli-5",
    symbol: "BTC-USD",
    side: "buy",
    quantity: "0.3",
    filled_quantity: "0.1",
    filled_amount: "9500",
    leaves_quantity: "0.2",
    price: "95000",
    average_fill_price: "95000",
    status: "partially_filled",
    created_date: now - 3 * HOUR_MS,
    updated_date: now - 3 * HOUR_MS,
  },
  {
    ...ORDER_BASE,
    id: "ord-6",
    client_order_id: "cli-6",
    symbol: "ETH-USD",
    side: "buy",
    quantity: "2",
    filled_quantity: "1",
    filled_amount: "3600",
    leaves_quantity: "1",
    price: "3600",
    average_fill_price: "3600",
    status: "partially_filled",
    created_date: now - 6 * HOUR_MS,
    updated_date: now - 6 * HOUR_MS,
  },
];

const BTC_USD_FILLS = [
  {
    id: "trd-1",
    orderId: "ord-a",
    symbol: "BTC-USD",
    side: "buy",
    price: "94500",
    quantity: "0.1",
    maker: false,
    timestamp: now - 22 * HOUR_MS,
  },
  {
    id: "trd-2",
    orderId: "ord-a",
    symbol: "BTC-USD",
    side: "buy",
    price: "94600",
    quantity: "0.05",
    maker: false,
    timestamp: now - 18 * HOUR_MS,
  },
  {
    id: "trd-3",
    orderId: "ord-b",
    symbol: "BTC-USD",
    side: "sell",
    price: "95200",
    quantity: "0.08",
    maker: true,
    timestamp: now - 10 * HOUR_MS,
  },
  {
    id: "trd-4",
    orderId: "ord-b",
    symbol: "BTC-USD",
    side: "sell",
    price: "95300",
    quantity: "0.07",
    maker: true,
    timestamp: now - 5 * HOUR_MS,
  },
];

const ORDER_ABC_FILLS = [
  {
    id: "fill-1",
    orderId: "abc-123",
    symbol: "BTC-USD",
    side: "buy",
    price: "94900",
    quantity: "0.1",
    maker: false,
    timestamp: now - 4 * HOUR_MS,
  },
  {
    id: "fill-2",
    orderId: "abc-123",
    symbol: "BTC-USD",
    side: "buy",
    price: "94950",
    quantity: "0.05",
    maker: false,
    timestamp: now - 3 * HOUR_MS,
  },
  {
    id: "fill-3",
    orderId: "abc-123",
    symbol: "BTC-USD",
    side: "buy",
    price: "95000",
    quantity: "0.05",
    maker: true,
    timestamp: now - 2 * HOUR_MS,
  },
];

describe("trading history — fills, P&L, multi-pair", () => {
  defineEval({
    name: "pnl-recent-period",
    description:
      "'How did I do' phrasing routes to get_historical_orders (filled+partially_filled, 7d window).",
    prompt: "how did I do this past week, roughly?",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValueOnce({
        data: PNL_WEEK_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsToolNTimes("get_historical_orders", 1),
      a.callsToolWithArgs("get_historical_orders", {
        order_states: ["filled", "partially_filled"],
      }),
      {
        name: "uses a ~7 day window (relative '7d', absolute ~7d ago, or 30d default acceptable)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const args = call.args as { start_date?: string };
          if (!args.start_date) return true;
          if (/^(7|14|30)\s*d$/i.test(args.start_date)) return true;
          const startMs = Date.parse(args.start_date);
          if (Number.isNaN(startMs)) return false;
          const days = (Date.now() - startMs) / DAY_MS;
          return days >= 5 && days <= 35;
        },
      },
      a.doesNotCallTool("get_client_trades"),
      a.doesNotCallTool("get_active_orders"),
      a.finalTextContainsAll(["USD"]),
      a.judge({
        name: "P&L-style summary; uses filled_amount only; partial fills included; no extrapolation",
        criterion:
          "The answer summarises the past-week activity using only the filled_amount values from the orders. " +
          "It includes the two partial fills in totals (not only the fully filled ones). " +
          "It does NOT annualize, extrapolate, or estimate returns beyond what the tool result shows. " +
          "Currency labels (USD) appear next to amounts.",
        rubric:
          "1.0 = clear summary, partial fills counted, USD-labelled, no extrapolation. " +
          "0.7 = correct totals but vague on partial fills. " +
          "0.4 = partial fills dropped or one number wrong. " +
          "0.0 = fabricated numbers or annualized returns invented.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "single-pair-fills-routing",
    description:
      "Single-pair raw fill stream → get_client_trades, not get_historical_orders.",
    prompt:
      "show me the BTC-USD fills from the last 24 hours, individual trades not aggregated",
    setup: () => {
      revolutXMockState.getPrivateTrades.mockResolvedValueOnce({
        data: BTC_USD_FILLS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_client_trades"),
      a.callsToolWithArgs("get_client_trades", { symbol: "BTC-USD" }),
      a.doesNotCallTool("get_historical_orders"),
      a.judge({
        name: "lists individual fills (not aggregated) with price, quantity, time",
        criterion:
          "The answer presents the fills as INDIVIDUAL trades (a list, table, or row-per-fill — not collapsed into one aggregate row), with each fill's price and quantity, and mentions UTC anywhere time appears. " +
          "Whether the maker/taker flag is shown for every row is nice-to-have but not required. " +
          "Specific numeric values from the tool result are assumed faithful — the judge cannot verify them and should not penalize them as 'fabricated' unless the agent obviously contradicts the tool's call args.",
        rubric:
          "1.0 = row-per-fill table/list, UTC mentioned. " +
          "0.7 = individual fills listed, UTC implicit. " +
          "0.4 = collapsed into a single aggregate (against user's request). " +
          "0.0 = unrelated answer.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "order-fills-detail",
    description:
      "Fills of one specific order → get_order_fills, not get_client_trades.",
    prompt: "for order abc-123, how was it filled — one big chunk or pieces?",
    setup: () => {
      revolutXMockState.getOrderFills.mockResolvedValueOnce({
        data: ORDER_ABC_FILLS,
      });
    },
    assertions: [
      a.callsTool("get_order_fills"),
      a.callsToolWithArgs("get_order_fills", { order_id: "abc-123" }),
      a.doesNotCallTool("get_client_trades"),
      a.doesNotCallTool("get_historical_orders"),
      a.judge({
        name: "answers the user's question directly: pieces (3 fills)",
        criterion:
          "The answer directly answers 'one chunk or pieces' — explicitly states that the order was filled in three separate executions (pieces). " +
          "It mentions the three fill quantities or prices.",
        rubric:
          "1.0 = direct answer ('pieces / 3 fills') + per-fill detail. " +
          "0.7 = direct answer, vague on per-fill detail. " +
          "0.4 = answers indirectly or claims one fill. " +
          "0.0 = wrong count or fabricated fills.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "large-query-confirmation",
    description:
      "Unbounded 'all orders ever' query → agent should confirm scope OR set a totalLimit.",
    prompt: "pull all my orders ever, complete history",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      {
        name: "either asks back for scope OR sets a totalLimit on the call",
        check: ({ toolCalls }) => {
          const calls = toolCalls.filter(
            (c) => c.name === "get_historical_orders",
          );
          if (calls.length === 0) return true;
          if (calls.length > 1) return false;
          const args = calls[0].args as { totalLimit?: number };
          return typeof args.totalLimit === "number" && args.totalLimit > 0;
        },
      },
      a.judge({
        name: "confirms scope or proactively bounds the query",
        criterion:
          "Either: the agent asks the user to confirm an unbounded query before running it (best), " +
          "OR it proactively sets a reasonable totalLimit / suggests narrowing the date range and explains why. " +
          "It does NOT silently run get_historical_orders with totalLimit omitted and no date bound.",
        rubric:
          "1.0 = explicit scope confirmation with the user. " +
          "0.7 = proactive totalLimit set, explained. " +
          "0.4 = ran without confirmation but mentioned the risk after. " +
          "0.0 = ran the unbounded query silently.",
        threshold: 0.7,
      }),
    ],
  });
});
