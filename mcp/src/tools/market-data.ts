import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Currency, CurrencyPair } from "revolutx-api";
import { textResult, validateSymbol, VALID_RESOLUTIONS } from "./_helpers.js";

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
      const { AuthNotConfiguredError } = await import("revolutx-api");

      let currencies;
      try {
        currencies = await getRevolutXClient().getCurrencies();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
        throw error;
      }

      const entries = Object.entries(currencies).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (!entries.length) {
        return textResult("No currencies found.");
      }

      const lines = [
        `${"Symbol".padStart(8)} | ${"Name".padEnd(20)} | ${"Type".padEnd(8)} | ${"Scale".padStart(5)} | ${"Status".padEnd(8)}`,
      ];
      lines.push("-".repeat(60));
      for (const [sym, info] of entries as [string, Currency][]) {
        lines.push(
          `${sym.padStart(8)} | ` +
            `${info.name.padEnd(20)} | ` +
            `${info.asset_type.padEnd(8)} | ` +
            `${String(info.scale).padStart(5)} | ` +
            `${info.status.padEnd(8)}`,
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
      const { AuthNotConfiguredError } = await import("revolutx-api");

      let pairs;
      try {
        pairs = await getRevolutXClient().getCurrencyPairs();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
        throw error;
      }

      const entries = Object.entries(pairs).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (!entries.length) {
        return textResult("No currency pairs found.");
      }

      const lines = [
        `${"Pair".padEnd(12)} | ${"Min Size".padStart(12)} | ${"Max Size".padStart(12)} | ` +
          `${"Base Step".padStart(10)} | ${"Status".padEnd(8)}`,
      ];
      lines.push("-".repeat(65));
      for (const [pairName, info] of entries as [string, CurrencyPair][]) {
        lines.push(
          `${pairName.padEnd(12)} | ` +
            `${info.min_order_size.padStart(12)} | ` +
            `${info.max_order_size.padStart(12)} | ` +
            `${info.base_step.padStart(10)} | ` +
            `${info.status.padEnd(8)}`,
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
      const { AuthNotConfiguredError } = await import("revolutx-api");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(20, limit));

      let result;
      try {
        result = await getRevolutXClient().getOrderBook(symbol, { limit });
      } catch (err) {
        if (err instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
        throw err;
      }

      const { asks, bids } = result.data;

      const outputLines = [`Order Book: ${symbol}\n`];

      outputLines.push("ASKS (Sell)".padStart(35));
      outputLines.push(
        `${"Price".padStart(14)} ${"Currency".padStart(8)} | ${"Quantity".padStart(14)} ${"Unit".padStart(6)} | ${"Orders".padStart(6)}`,
      );
      outputLines.push("-".repeat(58));
      for (const ask of [...asks].reverse()) {
        outputLines.push(
          `${ask.p.padStart(14)} ${ask.pc.padStart(8)} | ` +
            `${ask.q.padStart(14)} ${ask.qc.padStart(6)} | ` +
            `${ask.no.padStart(6)}`,
        );
      }

      outputLines.push("");

      outputLines.push("BIDS (Buy)".padStart(35));
      outputLines.push(
        `${"Price".padStart(14)} ${"Currency".padStart(8)} | ${"Quantity".padStart(14)} ${"Unit".padStart(6)} | ${"Orders".padStart(6)}`,
      );
      outputLines.push("-".repeat(58));
      for (const bid of bids) {
        outputLines.push(
          `${bid.p.padStart(14)} ${bid.pc.padStart(8)} | ` +
            `${bid.q.padStart(14)} ${bid.qc.padStart(6)} | ` +
            `${bid.no.padStart(6)}`,
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
        "Get current ticker data for all trading pairs. Returns bid, ask, mid, and last price for each pair.",
      annotations: {
        title: "Get Tickers",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      let result;
      try {
        result = await getRevolutXClient().getTickers();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
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
      description: "Get OHLCV candlestick data for a trading pair.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        resolution: z
          .string()
          .default("1h")
          .describe(
            'Candle interval — "5m", "15m", "30m", "1h", "4h", "1d", "2d", "4d", "1w", "2w", "4w" (default "1h")',
          ),
        limit: z
          .number()
          .default(50)
          .describe("Max number of candles (default 50)"),
      },
      annotations: {
        title: "Get Candlestick Data",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, resolution, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      if (!VALID_RESOLUTIONS.has(resolution)) {
        return textResult(
          `Invalid resolution '${resolution}'. ` +
            `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
        );
      }

      let result;
      try {
        result = await getRevolutXClient().getCandles(symbol, {
          interval: resolution,
        });
      } catch (err) {
        if (err instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
        throw err;
      }

      const candles = result.data.slice(0, limit);

      if (!candles.length) {
        return textResult(
          `No candle data found for ${symbol} (${resolution}).`,
        );
      }

      const lines = [`Candles for ${symbol} (${resolution}):\n`];
      lines.push(
        `${"Start".padEnd(20)} | ${"Open".padStart(12)} | ${"High".padStart(12)} | ${"Low".padStart(12)} | ${"Close".padStart(12)} | ${"Volume".padStart(14)}`,
      );
      lines.push("-".repeat(95));
      for (const c of candles) {
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
      description: "Get recent public trades for a trading pair.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Number of trades to return, 1-100 (default 20)"),
      },
      annotations: {
        title: "Get Public Trades",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(100, limit));

      let result;
      try {
        result = await getRevolutXClient().getAllTrades(symbol, { limit });
      } catch (err) {
        if (err instanceof AuthNotConfiguredError)
          return textResult(SETUP_GUIDE);
        throw err;
      }

      const trades = result.data;
      if (!trades.length)
        return textResult(`No recent trades found for ${symbol}.`);

      const lines = [`Recent trades for ${symbol}:\n`];
      lines.push(
        `${"Asset".padStart(8)} | ${"Price".padStart(14)} ${"Cur".padStart(4)} | ${"Quantity".padStart(14)} ${"Cur".padStart(4)} | Time`,
      );
      lines.push("-".repeat(65));
      for (const t of trades) {
        lines.push(
          `${t.aid.padStart(8)} | ` +
            `${t.p.padStart(14)} ${t.pc.padStart(4)} | ` +
            `${t.q.padStart(14)} ${t.qc.padStart(4)} | ` +
            `${t.tdt}`,
        );
      }

      if (result.metadata.next_cursor) {
        lines.push(
          `\nMore trades available (cursor: ${result.metadata.next_cursor})`,
        );
      }

      return textResult(lines.join("\n"));
    },
  );
}
