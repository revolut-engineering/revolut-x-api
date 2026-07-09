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
const now = Date.now();

const BALANCES = [
  { currency: "BTC", available: "1.5", reserved: "0.1", total: "1.6" },
  { currency: "ETH", available: "8", reserved: "0", total: "8" },
  { currency: "USD", available: "12000", reserved: "0", total: "12000" },
  { currency: "EUR", available: "3500", reserved: "0", total: "3500" },
];

const TICKERS = [
  {
    symbol: "BTC-USD",
    bid: "95100",
    ask: "95200",
    mid: "95150",
    last_price: "95150",
  },
  {
    symbol: "ETH-USD",
    bid: "3490",
    ask: "3510",
    mid: "3500",
    last_price: "3500",
  },
];

// A diverse market snapshot for the "day's movements" summary: large- and
// small-cap pairs, mixed quote currencies (USD + EUR), and a spread of
// gainers/losers of varying magnitude. `base`/`drift` drive the per-symbol
// candle series so each pair's intraday direction matches its ticker.
const MARKET_MOVERS: Array<{
  symbol: string;
  base: number;
  drift: number;
  ticker: {
    symbol: string;
    bid: string;
    ask: string;
    mid: string;
    last_price: string;
  };
}> = [
  {
    symbol: "BTC-USD",
    base: 95000,
    drift: 0.028,
    ticker: {
      symbol: "BTC-USD",
      bid: "97600",
      ask: "97700",
      mid: "97650",
      last_price: "97650",
    },
  },
  {
    symbol: "ETH-USD",
    base: 3500,
    drift: -0.041,
    ticker: {
      symbol: "ETH-USD",
      bid: "3352",
      ask: "3358",
      mid: "3355",
      last_price: "3355",
    },
  },
  {
    symbol: "SOL-USD",
    base: 150,
    drift: 0.117,
    ticker: {
      symbol: "SOL-USD",
      bid: "167.30",
      ask: "167.60",
      mid: "167.45",
      last_price: "167.45",
    },
  },
  {
    symbol: "XRP-USD",
    base: 0.6,
    drift: -0.085,
    ticker: {
      symbol: "XRP-USD",
      bid: "0.5486",
      ask: "0.5492",
      mid: "0.5489",
      last_price: "0.5489",
    },
  },
  {
    symbol: "DOGE-USD",
    base: 0.12,
    drift: 0.06,
    ticker: {
      symbol: "DOGE-USD",
      bid: "0.12710",
      ask: "0.12730",
      mid: "0.12720",
      last_price: "0.12720",
    },
  },
  {
    symbol: "ADA-EUR",
    base: 0.44,
    drift: -0.023,
    ticker: {
      symbol: "ADA-EUR",
      bid: "0.4297",
      ask: "0.4303",
      mid: "0.4300",
      last_price: "0.4300",
    },
  },
];

const ORDER_BASE = {
  type: "limit" as const,
  time_in_force: "gtc" as const,
  execution_instructions: ["allow_taker"],
};

const RECENT_ORDERS = [
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
];

function makeHourlyCandles(
  startMs: number,
  count: number,
  basePrice: number,
  driftPct = 0,
) {
  const decimals = basePrice < 1 ? 6 : 2;
  const span = count > 1 ? count - 1 : 1;
  // Absolute price level at step i: a linear trend from basePrice to
  // basePrice*(1+driftPct) plus a bounded oscillation around it. Computing
  // the level directly (rather than accumulating per-step deltas) keeps the
  // net move equal to `driftPct` so the series honours up/down direction.
  const levelAt = (i: number) =>
    basePrice * (1 + driftPct * (i / span)) +
    Math.sin(i / 6) * basePrice * 0.01;
  const candles = [];
  for (let i = 0; i < count; i++) {
    const open = i === 0 ? basePrice : levelAt(i - 1);
    const close = levelAt(i);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    candles.push({
      start: startMs + i * HOUR_MS,
      open: open.toFixed(decimals),
      high: high.toFixed(decimals),
      low: low.toFixed(decimals),
      close: close.toFixed(decimals),
      volume: (40 + Math.abs(Math.sin(i)) * 25).toFixed(4),
    });
  }
  return candles;
}

describe("release_starter_pack", () => {
  defineEval({
    name: "starter-portfolio-overview",
    description:
      "Release demo: 'Give me an overview of my portfolio' → reads balances and presents a grounded, currency-labelled overview.",
    failureModes: ["Other"],
    granularity: "End-to-End",
    workflow: "Account - Portfolio Performance",
    prompt: "Give me an overview of my portfolio",
    setup: () => {
      revolutXMockState.getBalances.mockResolvedValue(BALANCES);
      revolutXMockState.getTickers.mockResolvedValue({
        data: TICKERS,
        metadata: { timestamp: now },
      });
    },
    assertions: [
      a.callsTool("get_balances"),
      a.judge({
        name: "summarises held balances with currency labels; grounded in tool data",
        criterion:
          "Pass if: the answer presents an overview of the account holdings using the balances returned by the tool (e.g. BTC, ETH, USD, EUR) with each amount labelled by its currency. " +
          "Fail if: the holdings are fabricated or contradict the tool data, currencies are unlabelled throughout, or no portfolio overview is given.",
      }),
    ],
  });

  defineEval({
    name: "starter-recent-trades-deep-dive",
    description:
      "Release demo: 'Do a deep dive of my recent trades' → routes to get_historical_orders and summarises actual fills.",
    failureModes: ["Bad tool resolution"],
    granularity: "End-to-End",
    workflow: "Account - Orders",
    prompt: "Do a deep dive of my recent trades",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValue({
        data: RECENT_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.doesNotCallTool("get_active_orders"),
      a.judge({
        name: "analyses the returned trades; does not invent orders",
        criterion:
          "Pass if: the answer discusses the user's recent trades based on the orders returned by the tool (e.g. the BTC-USD buy/sell and the ETH-USD buy), referencing concrete details such as symbols, sides, or amounts with currency labels. " +
          "Fail if: the answer invents trades not present in the tool data, contradicts it, or gives no trade-level detail.",
      }),
    ],
  });

  defineEval({
    name: "starter-market-movements-summary",
    description:
      "Release demo: 'Give me a summary of the day's market movements' → reads a diverse live market snapshot (multiple pairs, mixed gainers/losers, USD + EUR quotes) and summarises it, no fabrication.",
    failureModes: ["Bad tool resolution"],
    granularity: "End-to-End",
    workflow: "Market - Prices",
    prompt: "Give me a summary of the day's market movements",
    setup: () => {
      revolutXMockState.getTickers.mockResolvedValue({
        data: MARKET_MOVERS.map((m) => m.ticker),
        metadata: { timestamp: now },
      });
      // Per-symbol candle series so each pair's intraday direction (up/down)
      // matches its ticker, rather than every symbol sharing one BTC series.
      revolutXMockState.getCandles.mockImplementation((symbol: string) => {
        const mover =
          MARKET_MOVERS.find((m) => m.symbol === symbol) ?? MARKET_MOVERS[0];
        return Promise.resolve({
          data: makeHourlyCandles(now - DAY_MS, 24, mover.base, mover.drift),
        });
      });
    },
    assertions: [
      {
        name: "reads live market data (tickers and/or candles)",
        check: ({ toolCalls }) =>
          toolCalls.some(
            (c) => c.name === "get_tickers" || c.name === "get_candles",
          ),
      },
      a.judge({
        name: "summarises the diverse market snapshot grounded in returned data with currency labels",
        criterion:
          "Pass if: the answer summarises the day's market across multiple pairs using the values returned by the market-data tool(s) (e.g. BTC-USD ~97,650, ETH-USD ~3,355, SOL-USD ~167, XRP-USD ~0.55, DOGE-USD ~0.127, ADA-EUR ~0.43), with prices labelled in their quote currency (USD and EUR). Covering most of the pairs is sufficient; it need not mention every one. " +
          "Fail if: prices are fabricated or contradict the tool data, the EUR-quoted pair is mislabelled as USD, or no market summary is provided.",
      }),
    ],
  });

  defineEval({
    name: "starter-telegram-alert-routes-to-setup",
    description:
      "Release demo: 'Ping me on Telegram when ETH hits $3,000' → recognises the read-only server cannot set up alerts and routes to get_trading_setup.",
    failureModes: ["Bad tool resolution"],
    granularity: "End-to-End",
    workflow: "Account setup/onboarding",
    prompt: "Ping me on Telegram when ETH hits $3,000",
    setup: () => {
      // No data mocks needed — the read-only routing path touches no client method.
    },
    assertions: [
      a.callsTool("get_trading_setup"),
      a.doesNotCallTool("search_kb"),
      a.doesNotCallTool("list_kb_articles"),
      a.judge({
        name: "explains read-only + routes to trading plugin for alerts; does not pretend to set up a monitor",
        criterion:
          "Pass if: the answer acknowledges this server is read-only (cannot set up price monitors, alerts, or Telegram notifications itself) AND points the user to the Revolut X trading plugin or Claude Code as the way to set up the alert (pointer may be brief). " +
          "Fail if: the answer implies a monitor/alert was created or scheduled, claims it will notify the user, or does not acknowledge the read-only constraint. " +
          "Do NOT penalize the presence of install commands or URLs — those come from the get_trading_setup tool output and are expected here.",
      }),
    ],
  });

  defineEval({
    name: "starter-grid-strategy-backtest",
    description:
      "Release demo: 'Try a grid strategy on BTC for the last 30 days' (under-specified) → either runs a grid simulation (backtest/optimize) with the simulation caveat, OR asks the user for the missing grid parameters. Either way, does not route to trading setup.",
    failureModes: ["Bad tool resolution"],
    granularity: "End-to-End",
    workflow: "Backtesting",
    prompt: "Try a grid strategy on BTC for the last 30 days",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValue({
        data: makeHourlyCandles(now - 30 * DAY_MS, 720, 95000),
      });
    },
    assertions: [
      a.doesNotCallTool("get_trading_setup"),
      a.judge({
        name: "runs a grid simulation with caveat, or asks the user for the missing grid parameters",
        criterion:
          "The request is under-specified: it gives no investment amount, number of grid levels, or price range. Two responses are acceptable. " +
          "Pass if EITHER: (a) the agent runs a grid simulation (backtest or optimize) on BTC over the last ~30 days and reports results (e.g. ROI, P&L, or suggested grid parameters) together with a caveat that this is a simulation of past data, not a prediction or guarantee of future performance; " +
          "OR (b) the agent asks the user to provide the missing grid parameters (such as investment amount, number of grid levels, and/or price range) before running, rather than inventing them. " +
          "Fail if: the agent routes the user to trading setup / the plugin instead of using the backtest tools, fabricates simulation results without running a simulation, or (when it does run a simulation) omits the simulation-not-a-prediction caveat.",
      }),
    ],
  });
});
