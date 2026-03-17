import { Command } from "commander";
import type { Ticker, Candle } from "revolutx-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  type ColumnDef,
} from "../output/formatter.js";

export function registerMarketCommand(program: Command): void {
  const market = program
    .command("market")
    .description("Market data and configuration")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market currencies             List supported currencies
  $ revx market pairs                  List trading pairs
  $ revx market tickers                List all tickers
  $ revx market ticker BTC-USD         Get BTC-USD ticker
  $ revx market candles BTC-USD        Get hourly candles
  $ revx market candles BTC-USD --interval 5  Get 5-minute candles
  $ revx market orderbook BTC-USD      Get order book (top 10)`,
    );

  market
    .command("currencies")
    .description("List all supported currencies")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const client = getClient({ requireAuth: true });
        const currencies = await client.getCurrencies();

        if (isJsonOutput(opts)) {
          printJson(currencies);
        } else {
          const rows = Object.values(currencies);
          printTable(rows, [
            { header: "Symbol", key: "symbol" },
            { header: "Name", key: "name" },
            { header: "Type", key: "asset_type" },
            { header: "Scale", key: "scale", align: "right" },
            { header: "Status", key: "status" },
          ]);
        }
      } catch (err) {
        handleError(err);
      }
    });

  market
    .command("pairs")
    .description("List all trading pairs")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const client = getClient({ requireAuth: true });
        const pairs = await client.getCurrencyPairs();

        if (isJsonOutput(opts)) {
          printJson(pairs);
        } else {
          const rows = Object.entries(pairs).map(([symbol, pair]) => ({
            symbol,
            ...pair,
          }));
          printTable(rows, [
            { header: "Pair", accessor: (r) => r.symbol },
            { header: "Base", key: "base" },
            { header: "Quote", key: "quote" },
            { header: "Min Size", key: "min_order_size", align: "right" },
            { header: "Max Size", key: "max_order_size", align: "right" },
            { header: "Status", key: "status" },
          ]);
        }
      } catch (err) {
        handleError(err);
      }
    });

  market
    .command("tickers")
    .description("List all tickers")
    .option(
      "--symbols <pairs>",
      "Filter by pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: { symbols?: string; json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const tickerOpts = opts.symbols
            ? { symbols: opts.symbols.split(",") }
            : undefined;
          const result = await client.getTickers(tickerOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printTickerTable(result.data);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("ticker <symbol>")
    .description("Get ticker for a specific pair (e.g. BTC-USD)")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (symbol: string, opts: { json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const result = await client.getTickers({ symbols: [symbol] });

          if (isJsonOutput(opts)) {
            printJson(result);
          } else if (result.data.length === 0) {
            console.error(`No ticker found for: ${symbol}`);
            process.exit(1);
          } else {
            const t = result.data[0];
            printKeyValue([
              ["Symbol", t.symbol],
              ["Bid", t.bid],
              ["Ask", t.ask],
              ["Mid", t.mid],
              ["Last", t.last_price],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("candles <symbol>")
    .description("Get OHLCV candles for a pair")
    .option(
      "--interval <value>",
      "Candle interval: string alias (1m,5m,15m,30m,1h,4h,1d,2d,4d,1w,2w,4w) or minutes",
      "1h",
    )
    .option(
      "--since <date>",
      "Start time (ISO date, epoch ms, or relative: 7d, 1w, 4h, today)",
    )
    .option(
      "--until <date>",
      "End time (ISO date, epoch ms, or relative: today, yesterday)",
    )
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: {
          interval: string;
          since?: string;
          until?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });

          const INTERVAL_ALIASES: Record<string, number> = {
            "1m": 1,
            "5m": 5,
            "15m": 15,
            "30m": 30,
            "1h": 60,
            "4h": 240,
            "1d": 1440,
            "2d": 2880,
            "4d": 5760,
            "1w": 10080,
            "2w": 20160,
            "4w": 40320,
          };

          const intervalMinutes =
            INTERVAL_ALIASES[opts.interval] ??
            parsePositiveInt(opts.interval, "interval");

          const candleOpts: {
            interval?: number | string;
            startDate?: number;
            endDate?: number;
          } = {};

          candleOpts.interval = intervalMinutes;
          if (opts.since) candleOpts.startDate = parseTimestamp(opts.since);
          if (opts.until) candleOpts.endDate = parseTimestamp(opts.until);

          const result = await client.getCandles(symbol, candleOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            const columns: ColumnDef<Candle>[] = [
              {
                header: "Time",
                accessor: (c) => new Date(c.start).toISOString(),
              },
              { header: "Open", key: "open", align: "right" },
              { header: "High", key: "high", align: "right" },
              { header: "Low", key: "low", align: "right" },
              { header: "Close", key: "close", align: "right" },
              { header: "Volume", key: "volume", align: "right" },
            ];
            printTable(result.data, columns);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("orderbook <symbol>")
    .description("Get order book for a pair")
    .option("--limit <n>", "Depth (1-20)", "10")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: { limit: string; json?: boolean; output?: string },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const result = await client.getOrderBook(symbol, {
            limit: parsePositiveInt(opts.limit, "limit"),
          });

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            console.log("\nAsks (sell):");
            printTable(result.data.asks.reverse(), [
              { header: "Price", key: "price", align: "right" },
              { header: "Quantity", key: "quantity", align: "right" },
              { header: "Orders", key: "orderCount", align: "right" },
            ]);
            console.log("\nBids (buy):");
            printTable(result.data.bids, [
              { header: "Price", key: "price", align: "right" },
              { header: "Quantity", key: "quantity", align: "right" },
              { header: "Orders", key: "orderCount", align: "right" },
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function printTickerTable(tickers: Ticker[]): void {
  printTable(tickers, [
    { header: "Symbol", key: "symbol" },
    { header: "Bid", key: "bid", align: "right" },
    { header: "Ask", key: "ask", align: "right" },
    { header: "Mid", key: "mid", align: "right" },
    { header: "Last", key: "last_price", align: "right" },
  ]);
}
