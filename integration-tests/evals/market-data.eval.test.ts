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
          "The answer reports the BTC-USD last price (around 95,150) with the USD currency label adjacent. " +
          "It does not call any reference or historical tool before answering.",
        rubric:
          "1.0 = price + USD label + direct answer. " +
          "0.7 = price correct, label vague or implicit. " +
          "0.4 = wrong price or label missing entirely. " +
          "0.0 = fabricated price or unrelated answer.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "historical-candles-window",
    description:
      "OHLCV question → get_candles with 1h resolution; UTC time labelling preserved.",
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
          "The answer summarises the day's ETH-USD price action with open/high/low/close-style figures and references the time range in UTC. " +
          "Note: the candle data is hourly, so the agent reporting specific hourly readings or hour-level peak/trough times IS faithful to the tool result — only minute-precise prices the tool didn't include would be fabrication.",
        rubric:
          "1.0 = clear OHLC summary + UTC labelled. " +
          "0.7 = summary present, UTC implicit. " +
          "0.4 = vague summary OR no UTC. " +
          "0.0 = wrong direction or unrelated answer.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "order-book-spread",
    description:
      "Spread question → get_order_book (live depth), not get_tickers.",
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
          "The answer reports the BTC-USD spread (best bid 95,000 USD vs best ask 95,050 USD; spread is 50 USD or ~0.05%). " +
          "Currency label USD appears next to the spread or prices. " +
          "It does not silently fall back to get_tickers data.",
        rubric:
          "1.0 = explicit spread value, USD-labelled, derived from the book. " +
          "0.7 = correct spread, label vague. " +
          "0.4 = wrong spread direction or magnitude. " +
          "0.0 = fabricated values or unrelated answer.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "currencies-reference",
    description:
      "What-coins question → get_currencies (the one case it's appropriate).",
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
          "The answer lists the crypto assets (BTC, ETH, SOL, USDC) and distinguishes them from the fiat currencies (USD, EUR). " +
          "It does not invent currencies that were absent from the tool result.",
        rubric:
          "1.0 = all crypto listed AND crypto/fiat distinction is explicit. " +
          "0.7 = all crypto listed, distinction implicit. " +
          "0.4 = missing one asset or invents one. " +
          "0.0 = significant fabrication.",
        threshold: 0.7,
      }),
    ],
  });
});
