import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Currency, CurrencyPair } from "api-k9x2a";
import {
  formatDescription,
  handleApiError,
  LARGE_DATASET_HINT,
  parseDateRange,
  REQUIRE_COMPLETE_DATA_HINT,
  textResult,
  validateResolution,
  validateSymbol,
} from "../shared/_helpers.js";
import {
  PAGINATED_DATA_MAX_LIMIT,
  TRADES_API_LIMIT,
  paginateWithDynamicWindows,
} from "api-k9x2a";
import { RESOLUTIONS_MAP } from "../shared/common.js";

export function registerMarketDataTools(server: McpServer): void {
  server.registerTool(
    "get_currencies",
    {
      title: "List Currencies",
      description: formatDescription(
        "Get all available currencies on Revolut X exchange. Returns currency symbols, names, asset types (crypto/fiat), decimal precision, and status.",
        [REQUIRE_COMPLETE_DATA_HINT, LARGE_DATASET_HINT],
      ),
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
        "Always returns 1 batch query. If the requested date range is too old or contains " +
        "more than 50,000 candles, it defaults to returning the last 50,000 candles from the current timestamp.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        resolution: z
          .string()
          .default("1h")
          .describe(
            'Candle interval — "1m", "5m", "15m", "30m", "1h", "4h", "1d", "2d", "4d", "1w", "2w", "4w" (default "1h")',
          ),
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of UTC time range. Accepts ISO format (e.g. '2024-01-15') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago).",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of UTC time range. Accepts ISO format (e.g. '2024-06-30') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). Defaults to 7 days after start_date if omitted, or current timestamp if both omitted.",
          ),
      },
      annotations: {
        title: "Get Candlestick Data",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, resolution, start_date, end_date }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const symError = validateSymbol(symbol);
      if (symError) return textResult(symError);

      const resError = validateResolution(resolution);
      if (resError) return resError;

      const dates = parseDateRange(start_date, end_date);
      if ("error" in dates) return dates.error;

      const intervalMs = RESOLUTIONS_MAP[resolution] || 60 * 60 * 1000;
      const now = Date.now();
      const maxHistoryMs = 50000 * intervalMs;
      const oldestAvailableDate = now - maxHistoryMs;

      let fetchStart = dates.parsedStartDate;
      let fetchEnd = dates.parsedEndDate || now;
      let llmNotice =
        "*** NOTE TO LLM: This is the complete batch for your request. There is no more data available. ***";

      if (dates.parsedEndDate && dates.parsedEndDate < oldestAvailableDate) {
        fetchStart = oldestAvailableDate;
        fetchEnd = now;
        llmNotice = `*** NOTE TO LLM: The requested data range (${start_date || "N/A"} to ${end_date || "N/A"}) does not exist. Here is the data for the last 50,000 candles from the current timestamp instead. ***`;
      } else if (
        !fetchStart ||
        Math.ceil((fetchEnd - fetchStart) / intervalMs) > 50000
      ) {
        fetchStart = oldestAvailableDate;
        fetchEnd = now;
        llmNotice =
          "*** NOTE TO LLM: The requested range contains more than 50,000 candles. Returning the last 50,000 candles from the current timestamp. This is all the data available. ***";
      }

      type Candle = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getCandles"]>
      >["data"][number];
      let candles: Candle[];

      try {
        const result = await getRevolutXClient().getCandles(symbol, {
          interval: resolution,
          startDate: fetchStart,
          endDate: fetchEnd,
        });
        candles = result.data;
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      if (!candles || !candles.length) {
        return textResult(
          `No candle data found for ${symbol} (${resolution}).`,
        );
      }

      const lines = [
        `Candles for ${symbol} (${resolution}, ${candles.length} total):\n`,
      ];
      lines.push(
        `${"Start".padEnd(24)} | ${"Open".padStart(12)} | ${"High".padStart(12)} | ${"Low".padStart(12)} | ${"Close".padStart(12)} | ${"Volume".padStart(14)}`,
      );
      lines.push("-".repeat(99));

      for (const c of candles) {
        const readableStart = new Date(Number(c.start)).toISOString();

        lines.push(
          `${readableStart.padEnd(24)} | ` +
            `${c.open.padStart(12)} | ` +
            `${c.high.padStart(12)} | ` +
            `${c.low.padStart(12)} | ` +
            `${c.close.padStart(12)} | ` +
            `${c.volume.padStart(14)}`,
        );
      }

      lines.push("");
      lines.push(llmNotice);

      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_public_trades",
    {
      title: "Get public Trades",
      description:
        "Get public trade history for a trading pair. " +
        "Handles all pagination internally — NEVER call this tool multiple times to paginate or split date ranges. " +
        "IMPORTANT: If totalLimit is omitted, the result may be very large (>10,000 trades). " +
        "Always ask the user to confirm before fetching without a totalLimit, or suggest a reasonable totalLimit.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of UTC date range. Accepts ISO format (e.g. '2024-01-15') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). Defaults to 7 days before end_date if omitted.",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of UTC date range. Accepts ISO format (e.g. '2024-06-30') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). Defaults to 7 days after start_date if omitted, or current timestamp if both omitted.",
          ),
        totalLimit: z
          .number()
          .int()
          .positive()
          .max(PAGINATED_DATA_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum total number of trades to return across all paginated batches. Max is ${PAGINATED_DATA_MAX_LIMIT}. ` +
              "WARNING: If omitted, ALL trades in the date range are returned which may be very large (>10,000). " +
              "Always ask the user to confirm or suggest a reasonable limit before omitting this parameter.",
          ),
      },
      annotations: {
        title: "Get All Trades",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, start_date, end_date, totalLimit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      const dates = parseDateRange(start_date, end_date);
      if ("error" in dates) return dates.error;
      const { parsedStartDate, parsedEndDate } = dates;

      type PublicTrade = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getAllTrades"]>
      >["data"][number];

      let displayTrades: PublicTrade[];

      try {
        const client = getRevolutXClient();
        displayTrades = await paginateWithDynamicWindows<PublicTrade>({
          fetchPage: (startDate, endDate, cursor, apiLimit) =>
            client.getAllTrades(symbol, {
              startDate,
              endDate,
              cursor,
              limit: apiLimit,
            }),
          startDate: parsedStartDate,
          endDate: parsedEndDate,
          apiLimit: TRADES_API_LIMIT,
          userLimit: totalLimit,
        });
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      if (!displayTrades.length)
        return textResult(`No trades found for ${symbol}.`);
      const lines = [
        `All trades for ${symbol} (${displayTrades.length} returned):\n`,
      ];
      lines.push(
        `${"ID".padEnd(36)} | ${"Symbol".padStart(10)} | ${"Price".padStart(14)} | ${"Quantity".padStart(14)} | Time`,
      );
      lines.push("-".repeat(95));
      for (const t of displayTrades) {
        lines.push(
          `${t.id.padEnd(36)} | ` +
            `${t.symbol.padStart(10)} | ` +
            `${t.price.padStart(14)} | ` +
            `${t.quantity.padStart(14)} | ` +
            `${new Date(t.timestamp).toISOString()}`,
        );
      }

      lines.push("");
      lines.push(
        `*** NOTE TO LLM: Results above are for the range ${new Date(parsedStartDate).toISOString()} to ${new Date(parsedEndDate).toISOString()}. Do NOT request additional data automatically — ask the user if they want to fetch a different date range first. ***`,
      );

      return textResult(lines.join("\n"));
    },
  );
}
