import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeSparseHourlyCandles(): Array<{
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}> {
  const now = Date.now();
  const yesterdayStart = now - DAY_MS - (now % HOUR_MS);
  const candles = [];
  let price = 3500;

  // Hours 0–5: present
  for (let i = 0; i < 6; i++) {
    const open = price;
    const close = open * (i % 2 === 0 ? 1.002 : 0.998);
    candles.push({
      start: yesterdayStart + i * HOUR_MS,
      open: open.toFixed(2),
      high: (open * 1.003).toFixed(2),
      low: (open * 0.997).toFixed(2),
      close: close.toFixed(2),
      volume: "12.0000",
    });
    price = close;
  }
  // Hours 6–11: missing (6-hour gap)

  // Hours 12–23: present
  for (let i = 12; i < 24; i++) {
    const open = price;
    const close = open * (i % 2 === 0 ? 1.002 : 0.998);
    candles.push({
      start: yesterdayStart + i * HOUR_MS,
      open: open.toFixed(2),
      high: (open * 1.003).toFixed(2),
      low: (open * 0.997).toFixed(2),
      close: close.toFixed(2),
      volume: "12.0000",
    });
    price = close;
  }

  return candles;
}

const ETH_PUBLIC_TRADES = Array.from({ length: 100 }, (_, i) => ({
  id: `trade-eth-${i}`,
  symbol: "ETH-USD",
  price: (3500 + (i % 20) - 10).toString(),
  quantity: "0.10",
  timestamp: Date.now() - (100 - i) * 60_000,
}));

const ORDER_WITHOUT_FEE = {
  id: "xyz-789",
  client_order_id: "cli-xyz-789",
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
  created_date: Date.now() - 2 * HOUR_MS,
  updated_date: Date.now() - 2 * HOUR_MS,
  // Deliberately no total_fee or fee_currency fields
};

describe("data quality — gaps, truncation, absent fields", () => {
  defineEval({
    name: "sparse-candle-partial-gaps",
    description:
      "18 of 24 hourly candles returned (hours 6–11 missing) → agent must acknowledge the gap; must not interpolate or invent prices for missing hours.",
    failureModes: ["Hallucination", "Timeframe resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "what did ETH-USD do yesterday hour by hour?",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValueOnce({
        data: makeSparseHourlyCandles(),
      });
    },
    assertions: [
      a.callsTool("get_candles"),
      a.doesNotCallTool("get_tickers"),
      a.judge({
        name: "acknowledges missing hours; does not invent prices for the gap",
        criterion:
          "Pass if: the answer explicitly notes that some hourly data is unavailable or missing for yesterday, and does not provide ETH-USD price figures for those missing hours (or clearly marks them as unknown). " +
          "Fail if: all 24 hours are presented as complete, specific prices are given for the missing hours (hours 6–11), or the data gap is not mentioned at all.",
      }),
    ],
  });

  defineEval({
    name: "public-trades-requires-scope-before-fetch",
    description:
      "Unbounded public trades request → agent must set totalLimit or confirm scope before calling; omitting it risks fetching millions of rows.",
    failureModes: ["Other"],
    granularity: "End-to-End",
    workflow: "Market - Public Trades",
    prompt: "show me all ETH-USD public trades",
    setup: () => {
      revolutXMockState.getAllTrades.mockResolvedValue({
        data: ETH_PUBLIC_TRADES,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      {
        name: "either asks user for scope OR sets totalLimit before fetching",
        check: ({ toolCalls }) => {
          const call = toolCalls.find((c) => c.name === "get_public_trades");
          if (!call) return true;
          return (
            typeof (call.args as { totalLimit?: number }).totalLimit === "number"
          );
        },
      },
      a.judge({
        name: "bounds the query or asks user before fetching unbounded public trades",
        criterion:
          "Pass if: the agent either sets a totalLimit before calling get_public_trades, or asks the user to confirm scope (time window or count) before making any call. " +
          "Fail if: get_public_trades is called with no totalLimit and no prior scoping — this mirrors the unbounded-historical-orders failure mode.",
      }),
    ],
  });

  defineEval({
    name: "order-missing-fee-not-invented",
    description:
      "Order lookup where the API returns no fee data → agent must state fee is unavailable; must not fabricate a fee amount.",
    failureModes: ["Hallucination"],
    granularity: "Tool-specific",
    workflow: "Account - Trading History",
    prompt: "what fee did I pay on order xyz-789?",
    setup: () => {
      revolutXMockState.getOrder.mockResolvedValueOnce({
        data: ORDER_WITHOUT_FEE,
      });
    },
    assertions: [
      a.callsTool("get_order_by_id"),
      a.judge({
        name: "states fee information is unavailable; does not fabricate a fee amount",
        criterion:
          "Pass if: the answer explicitly states that fee information is not available for this order, or that the API did not return fee data. " +
          "Fail if: a specific fee amount or percentage is given (even qualified with 'approximately' or 'typically'), suggesting fabrication from training data rather than from the tool output.",
      }),
    ],
  });
});
