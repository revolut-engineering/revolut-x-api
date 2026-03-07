import { Command } from "commander";
import type { Ticker, Candle } from "revolutx-api";
import { getClient, getPublicClient } from "../util/client.js";
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
  $ revx market orderbook BTC-USD      Get order book (top 10)
  $ revx market trades                 Get recent public trades`,
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
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const client = getClient({ requireAuth: true });
        const result = await client.getTickers();

        if (isJsonOutput(opts)) {
          printJson(result);
        } else {
          printTickerTable(result.data);
        }
      } catch (err) {
        handleError(err);
      }
    });

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
    .option("--interval <minutes>", "Candle interval in minutes", "60")
    .option("--since <timestamp>", "Start time (ISO date or epoch ms)")
    .option("--until <timestamp>", "End time (ISO date or epoch ms)")
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
          const candleOpts: {
            interval?: number;
            since?: number;
            until?: number;
          } = {};

          candleOpts.interval = parsePositiveInt(opts.interval, "interval");
          if (opts.since) candleOpts.since = parseTimestamp(opts.since);
          if (opts.until) candleOpts.until = parseTimestamp(opts.until);

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
              { header: "Price", key: "p", align: "right" },
              { header: "Quantity", key: "q", align: "right" },
              { header: "Orders", key: "no", align: "right" },
            ]);
            console.log("\nBids (buy):");
            printTable(result.data.bids, [
              { header: "Price", key: "p", align: "right" },
              { header: "Quantity", key: "q", align: "right" },
              { header: "Orders", key: "no", align: "right" },
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("trades [symbol]")
    .description(
      "Get trades (public last-trades if no symbol, or all trades for a pair)",
    )
    .option("--start-date <date>", "Start date (ISO or epoch ms)")
    .option("--end-date <date>", "End date (ISO or epoch ms)")
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string | undefined,
        opts: {
          startDate?: string;
          endDate?: string;
          limit?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          if (!symbol) {
            const client = getPublicClient();
            const result = await client.getLastTrades();
            let trades = result.data;

            if (opts.startDate) {
              const start = parseTimestamp(opts.startDate);
              trades = trades.filter((t) => new Date(t.tdt).getTime() >= start);
            }
            if (opts.endDate) {
              const end = parseTimestamp(opts.endDate);
              trades = trades.filter((t) => new Date(t.tdt).getTime() <= end);
            }
            if (opts.limit) {
              trades = trades.slice(0, parsePositiveInt(opts.limit, "limit"));
            }

            if (isJsonOutput(opts)) {
              printJson({ ...result, data: trades });
            } else {
              printTable(trades, [
                { header: "Time", key: "tdt" },
                { header: "Asset", key: "anm" },
                { header: "Price", key: "p", align: "right" },
                { header: "Qty", key: "q", align: "right" },
                { header: "Side", key: "vp" },
              ]);
            }
          } else {
            const client = getClient({ requireAuth: true });
            const tradeOpts: {
              startDate?: number;
              endDate?: number;
              limit?: number;
            } = {};
            if (opts.startDate)
              tradeOpts.startDate = parseTimestamp(opts.startDate);
            if (opts.endDate) tradeOpts.endDate = parseTimestamp(opts.endDate);
            if (opts.limit)
              tradeOpts.limit = parsePositiveInt(opts.limit, "limit");

            const result = await client.getAllTrades(symbol, tradeOpts);

            if (isJsonOutput(opts)) {
              printJson(result);
            } else {
              printTable(result.data, [
                {
                  header: "Time",
                  accessor: (t) => new Date(t.tdt).toISOString(),
                },
                { header: "Asset", key: "anm" },
                { header: "Price", key: "p", align: "right" },
                { header: "Qty", key: "q", align: "right" },
                { header: "Trade ID", key: "tid" },
              ]);
            }
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
