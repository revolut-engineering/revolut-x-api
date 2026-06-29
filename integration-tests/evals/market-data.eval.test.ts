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

function makeHourlyCandles(symbol: string, startMs: number, count: number) {
  const candles = [];
  let price = symbol.startsWith("ETH") ? 3500 : 95000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const high = open * 1.005;
    const low = open * 0.995;
    const close = open * (1 + Math.sin(i) * 0.005);
    candles.push({
      start: startMs + i * HOUR_MS,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volume: (50 + Math.abs(Math.sin(i)) * 30).toFixed(4),
    });
    price = close;
  }
  return candles;
}

describe("market data — live prices, candles, depth, reference", () => {
  defineEval({
    name: "live-price-btc",
    description: "Casual 'how much is BTC right now' → get_tickers only.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "how much is BTC right now",
    setup: () => {
      revolutXMockState.getTickers.mockResolvedValueOnce({
        data: [
          {
            symbol: "BTC-USD",
            bid: "95100",
            ask: "95200",
            mid: "95150",
            last_price: "95150",
          },
        ],
        metadata: { timestamp: Date.now() },
      });
    },
    assertions: [
      a.callsTool("get_tickers"),
      a.callsToolNTimes("get_tickers", 1),
      a.doesNotCallTool("get_candles"),
      a.doesNotCallTool("get_currencies"),
      a.doesNotCallTool("get_currency_pairs"),
      a.finalTextMatches(/95[,\s]?150/),
      a.judge({
        name: "answers with BTC-USD price labelled in USD; no preamble noise",
        criterion:
          "Pass if: the answer reports the BTC-USD last price (around 95,150) with a USD label adjacent or implicit. " +
          "Fail if: the price is wrong, the USD label is entirely absent, or the answer is fabricated or unrelated.",
      }),
    ],
  });

  defineEval({
    name: "historical-candles-window",
    description:
      "OHLCV question → get_candles with 1h resolution; UTC time labelling preserved.",
    failureModes: ["Timeframe resolution", "Hallucination"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "what did ETH-USD do yesterday on a 1-hour resolution",
    setup: () => {
      const start = Date.now() - 2 * DAY_MS;
      revolutXMockState.getCandles.mockResolvedValueOnce({
        data: makeHourlyCandles("ETH-USD", start, 24),
      });
    },
    assertions: [
      a.callsTool("get_candles"),
      a.callsToolWithArgs("get_candles", {
        symbol: "ETH-USD",
        resolution: "1h",
      }),
      a.doesNotCallTool("get_tickers"),
      a.doesNotCallTool("get_currencies"),
      a.judge({
        name: "provides OHLC-style summary with UTC time references",
        criterion:
          "Pass if: the answer summarises ETH-USD price action with OHLC-style figures and preserves the local-time timestamps from the tool output (tool timestamps are labelled '(local)', not UTC); hourly readings faithful to the tool result are acceptable. " +
          "Fail if: the summary is absent or vague with no OHLC figures, timestamps are converted to UTC (which contradicts the server instruction to preserve local time), or the answer has the wrong direction or is unrelated.",
      }),
    ],
  });

  defineEval({
    name: "order-book-spread",
    description:
      "Spread question → get_order_book (live depth), not get_tickers.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Order Book",
    prompt: "what's the BTC-USD spread look like right now?",
    setup: () => {
      revolutXMockState.getOrderBook.mockResolvedValueOnce({
        data: {
          bids: [
            { price: "95000", quantity: "0.8", orderCount: 5 },
            { price: "94950", quantity: "1.2", orderCount: 4 },
            { price: "94900", quantity: "2.0", orderCount: 6 },
          ],
          asks: [
            { price: "95050", quantity: "0.5", orderCount: 3 },
            { price: "95100", quantity: "1.0", orderCount: 4 },
            { price: "95150", quantity: "1.5", orderCount: 5 },
          ],
        },
      });
    },
    assertions: [
      a.callsTool("get_order_book"),
      a.callsToolWithArgs("get_order_book", { symbol: "BTC-USD" }),
      a.doesNotCallTool("get_tickers"),
      a.judge({
        name: "reports the spread with USD label; does not swap to another tool",
        criterion:
          "Pass if: the answer reports the BTC-USD spread (50 USD, derived from best bid 95,000 and best ask 95,050) with a USD label adjacent or implicit. " +
          "Fail if: the spread direction or magnitude is wrong, the USD label is entirely absent, or values are fabricated.",
      }),
    ],
  });

  defineEval({
    name: "currencies-reference",
    description:
      "What-coins question → get_currencies (the one case it's appropriate).",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "what coins can I trade on revolut x?",
    setup: () => {
      revolutXMockState.getCurrencies.mockResolvedValueOnce({
        BTC: {
          symbol: "BTC",
          name: "Bitcoin",
          scale: 8,
          asset_type: "crypto",
          status: "active",
        },
        ETH: {
          symbol: "ETH",
          name: "Ethereum",
          scale: 8,
          asset_type: "crypto",
          status: "active",
        },
        SOL: {
          symbol: "SOL",
          name: "Solana",
          scale: 8,
          asset_type: "crypto",
          status: "active",
        },
        USDC: {
          symbol: "USDC",
          name: "USD Coin",
          scale: 6,
          asset_type: "crypto",
          status: "active",
        },
        USD: {
          symbol: "USD",
          name: "US Dollar",
          scale: 2,
          asset_type: "fiat",
          status: "active",
        },
        EUR: {
          symbol: "EUR",
          name: "Euro",
          scale: 2,
          asset_type: "fiat",
          status: "active",
        },
      });
    },
    assertions: [
      a.callsTool("get_currencies"),
      a.doesNotCallTool("get_tickers"),
      a.doesNotCallTool("get_historical_orders"),
      a.finalTextContainsAll(["BTC", "ETH"]),
      a.judge({
        name: "lists tradeable crypto; distinguishes crypto from fiat",
        criterion:
          "Pass if: the answer lists all four crypto assets (BTC, ETH, SOL, USDC) and distinguishes them from the fiat currencies (USD, EUR); the distinction may be implicit. " +
          "Fail if: one or more crypto assets are missing, a currency is invented, or there is significant fabrication.",
      }),
    ],
  });
});
