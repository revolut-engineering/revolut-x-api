import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Currency, CurrencyPair } from "revolutx-api";
import {
  textResult,
  validateSymbol,
  VALID_RESOLUTIONS,
  handleApiError,
  fetchAllChunked,
  candleChunkMs,
  fetchAllCandlesChunked,
} from "./_helpers.js";

export function registerMarketDataTools(server: McpServer): void {
  server.registerTool(
    "get_currencies",
    {
      title: "List Currencies",
      description:
        "Get all available currencies on Revolut X exchange. Returns currency symbols, names, asset types (crypto/fiat), decimal precision, and status.",
      annotations: {
        title: "List Currencies",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let currencies;
      try {
        currencies = await getRevolutXClient().getCurrencies();
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const entries = Object.entries(currencies).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (!entries.length) {
        return textResult("No currencies found.");
      }

      const lines = [`Currencies (${entries.length} total):\n`];
      for (const [sym, info] of entries as [string, Currency][]) {
        lines.push(
          `  Symbol: ${sym}\n` +
            `  Name: ${info.name}\n` +
            `  Type: ${info.asset_type}\n` +
            `  Scale: ${info.scale}\n` +
            `  Status: ${info.status}\n`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_currency_pairs",
    {
      title: "List Currency Pairs",
      description:
        "Get all tradeable currency pairs on Revolut X exchange. Returns pair details including base/quote currencies, step sizes, min/max order sizes, and status.",
      annotations: {
        title: "List Currency Pairs",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let pairs;
      try {
        pairs = await getRevolutXClient().getCurrencyPairs();
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const entries = Object.entries(pairs).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (!entries.length) {
        return textResult("No currency pairs found.");
      }

      const lines = [`Currency Pairs (${entries.length} total):\n`];
      for (const [pairName, info] of entries as [string, CurrencyPair][]) {
        lines.push(
          `  Pair: ${pairName}\n` +
            `  Base: ${info.base}\n` +
            `  Quote: ${info.quote}\n` +
            `  Base Step: ${info.base_step}\n` +
            `  Quote Step: ${info.quote_step}\n` +
            `  Min Order Size: ${info.min_order_size}\n` +
            `  Max Order Size: ${info.max_order_size}\n` +
            `  Min Order Size (Quote): ${info.min_order_size_quote}\n` +
            `  Status: ${info.status}\n`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_order_book",
    {
      title: "Get Order Book",
      description: "Get the current order book for a trading pair.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(20)
          .describe("Depth of order book, 1-20 (default 20)"),
      },
      annotations: {
        title: "Get Order Book",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(20, limit));

      let result;
      try {
        result = await getRevolutXClient().getOrderBook(symbol, { limit });
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      const { asks, bids } = result.data;

      const outputLines = [`Order Book: ${symbol}\n`];

      outputLines.push("ASKS (Sell)".padStart(30));
      outputLines.push(
        `${"Price".padStart(14)} | ${"Quantity".padStart(14)} | ${"Orders".padStart(6)}`,
      );
      outputLines.push("-".repeat(42));
      for (const ask of [...asks].reverse()) {
        outputLines.push(
          `${ask.price.padStart(14)} | ` +
            `${ask.quantity.padStart(14)} | ` +
            `${String(ask.orderCount).padStart(6)}`,
        );
      }

      outputLines.push("");

      outputLines.push("BIDS (Buy)".padStart(30));
      outputLines.push(
        `${"Price".padStart(14)} | ${"Quantity".padStart(14)} | ${"Orders".padStart(6)}`,
      );
      outputLines.push("-".repeat(42));
      for (const bid of bids) {
        outputLines.push(
          `${bid.price.padStart(14)} | ` +
            `${bid.quantity.padStart(14)} | ` +
            `${String(bid.orderCount).padStart(6)}`,
        );
      }

      return textResult(outputLines.join("\n"));
    },
  );

  server.registerTool(
    "get_tickers",
    {
      title: "Get Tickers",
      description:
        "Get current ticker data for trading pairs. Returns bid, ask, mid, and last price for each pair.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by trading pairs, e.g. ["BTC-USD", "ETH-USD"]. Omit to get all pairs.',
          ),
      },
      annotations: {
        title: "Get Tickers",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbols }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let result;
      try {
        result = await getRevolutXClient().getTickers({ symbols });
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const tickers = result.data;
      if (!tickers.length) return textResult("No ticker data available.");

      const lines = [
        `${"Pair".padEnd(12)} | ${"Bid".padStart(14)} | ${"Ask".padStart(14)} | ${"Mid".padStart(14)} | ${"Last".padStart(14)}`,
      ];
      lines.push("-".repeat(78));
      for (const t of tickers) {
        lines.push(
          `${t.symbol.padEnd(12)} | ` +
            `${t.bid.padStart(14)} | ` +
            `${t.ask.padStart(14)} | ` +
            `${t.mid.padStart(14)} | ` +
            `${t.last_price.padStart(14)}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_candles",
    {
      title: "Get Candlestick Data",
      description:
        "Get OHLCV candlestick data for a trading pair. " +
        "When start_date and end_date are provided, automatically fetches all pages in " +
        "1000-candle chunks. Without a date range, returns a single batch.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        resolution: z
          .string()
          .default("1h")
          .describe(
            'Candle interval — "1m", "5m", "15m", "30m", "1h", "4h", "1d", "2d", "4d", "1w", "2w", "4w" (default "1h")',
          ),
        limit: z
          .number()
          .min(1)
          .default(1000)
          .describe("Max number of candles to return (default 1000)."),
        start_date: z
          .number()
          .optional()
          .describe("Start of time range as epoch milliseconds."),
        end_date: z
          .number()
          .optional()
          .describe("End of time range as epoch milliseconds."),
      },
      annotations: {
        title: "Get Candlestick Data",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, resolution, limit, start_date, end_date }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      if (!VALID_RESOLUTIONS.has(resolution)) {
        return textResult(
          `Invalid resolution '${resolution}'. ` +
            `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
        );
      }

      type Candle = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getCandles"]>
      >["data"][number];
      let candles: Candle[];

      try {
        if (start_date !== undefined && end_date !== undefined) {
          candles = await fetchAllCandlesChunked(
            (startDate, endDate) =>
              getRevolutXClient().getCandles(symbol!, {
                interval: resolution,
                startDate,
                endDate,
              }),
            start_date,
            end_date,
            candleChunkMs(resolution),
          );
        } else {
          const result = await getRevolutXClient().getCandles(symbol, {
            interval: resolution,
            startDate: start_date,
            endDate: end_date,
          });
          candles = result.data;
        }
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      if (!candles.length) {
        return textResult(
          `No candle data found for ${symbol} (${resolution}).`,
        );
      }

      const sliced = candles.slice(0, limit);
      const lines = [
        `Candles for ${symbol} (${resolution}, ${sliced.length} total):\n`,
      ];
      lines.push(
        `${"Start".padEnd(20)} | ${"Open".padStart(12)} | ${"High".padStart(12)} | ${"Low".padStart(12)} | ${"Close".padStart(12)} | ${"Volume".padStart(14)}`,
      );
      lines.push("-".repeat(95));
      for (const c of sliced) {
        lines.push(
          `${String(c.start).padEnd(20)} | ` +
            `${c.open.padStart(12)} | ` +
            `${c.high.padStart(12)} | ` +
            `${c.low.padStart(12)} | ` +
            `${c.close.padStart(12)} | ` +
            `${c.volume.padStart(14)}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_public_trades",
    {
      title: "Get Public Trades",
      description:
        "Get public trades for a trading pair. " +
        "When start_date and end_date are provided, automatically fetches all pages across " +
        "7-day chunks. Without a date range, returns a single page — use cursor to paginate manually.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        start_date: z
          .number()
          .optional()
          .describe("Start of date range as epoch milliseconds."),
        end_date: z
          .number()
          .optional()
          .describe("End of date range as epoch milliseconds."),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor from a previous response. Only used when no date range is provided.",
          ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(100)
          .describe("Trades per page, 1-100 (default 100)"),
      },
      annotations: {
        title: "Get Public Trades",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, start_date, end_date, cursor, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(100, limit));

      type PublicTrade = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getAllTrades"]>
      >["data"][number];
      let allTrades: PublicTrade[];
      let nextCursor: string | undefined;

      try {
        if (start_date !== undefined && end_date !== undefined) {
          allTrades = await fetchAllChunked(
            (startDate, endDate, cur) =>
              getRevolutXClient().getAllTrades(symbol!, {
                startDate,
                endDate,
                cursor: cur,
                limit,
              }),
            start_date,
            end_date,
          );
        } else {
          const result = await getRevolutXClient().getAllTrades(symbol, {
            startDate: start_date,
            endDate: end_date,
            cursor,
            limit,
          });
          allTrades = result.data;
          nextCursor = result.metadata.next_cursor;
        }
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      if (!allTrades.length)
        return textResult(`No trades found for ${symbol}.`);

      const lines = [
        `Public trades for ${symbol} (${allTrades.length} total):\n`,
      ];
      lines.push(
        `${"ID".padEnd(36)} | ${"Symbol".padStart(10)} | ${"Price".padStart(14)} | ${"Quantity".padStart(14)} | Time`,
      );
      lines.push("-".repeat(100));
      for (const t of allTrades) {
        lines.push(
          `${t.id.padEnd(36)} | ` +
            `${t.symbol.padStart(10)} | ` +
            `${t.price.padStart(14)} | ` +
            `${t.quantity.padStart(14)} | ` +
            `${new Date(t.timestamp).toISOString()}`,
        );
      }

      if (nextCursor) {
        lines.push(`\nMore trades available (cursor: ${nextCursor})`);
      }

      return textResult(lines.join("\n"));
    },
  );
}
