import { Command } from "commander";
import chalk from "chalk";
import type { Ticker, Candle } from "@revolut/revolut-x-api";
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

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(50)));
}

export function registerMarketCommand(program: Command): void {
  const market = program
    .command("market")
    .description("Market data and configuration")
    .configureOutput({
      outputError: (str, write) => {
        const cleanedMsg = str.replace(/^error:\s*/i, "").trim();
        write(`${chalk.red.bold("✖ Error:")} ${chalk.white(cleanedMsg)}\n`);
      },
    })
    .addHelpText(
      "after",
      `
Examples:
  $ revx market currencies                        List all currencies
  $ revx market currencies fiat                   List fiat currencies only
  $ revx market currencies crypto                 List crypto currencies only
  $ revx market currencies --filter BTC,ETH       Get specific currencies by symbol
  $ revx market pairs                             List all trading pairs
  $ revx market pairs --filter BTC-USD,ETH-USD    Filter by multiple pairs
  $ revx market tickers                           List all tickers
  $ revx market tickers BTC-USD                   Get BTC-USD ticker
  $ revx market candles BTC-USD                   Get hourly candles
  $ revx market candles BTC-USD --interval 5      Get 5-minute candles
  $ revx market orderbook BTC-USD                 Get order book (top 10)`,
    );

  market
    .command("currencies [type]")
    .description(
      "List supported currencies, optionally filtered by type (fiat|crypto) or symbols",
    )
    .addHelpText(
      "after",
      `
Arguments:
  type  Filter by asset type: fiat or crypto (optional)

Examples:
  $ revx market currencies                        List all currencies
  $ revx market currencies fiat                   List fiat currencies only
  $ revx market currencies crypto                 List crypto currencies only
  $ revx market currencies --filter BTC,ETH       Get specific currencies by symbol
  $ revx market currencies --json                 Output as JSON`,
    )
    .option(
      "-f, --filter <symbols>",
      "Filter by specific symbols (comma-separated, e.g., BTC,ETH)",
    )
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        type: string | undefined,
        opts: { filter?: string; json?: boolean; output?: string },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const currencies = await client.getCurrencies();

          const CURRENCY_COLUMNS = [
            { header: "Symbol", key: "symbol" as const },
            { header: "Name", key: "name" as const },
            { header: "Type", key: "asset_type" as const },
            { header: "Scale", key: "scale" as const, align: "right" as const },
            { header: "Status", key: "status" as const },
          ];

          if (type && type !== "fiat" && type !== "crypto") {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(`Invalid type: "${chalk.cyan(type)}". Use "fiat" or "crypto".`)}`,
            );
            console.error(
              chalk.gray(
                `  ↳ To search for a symbol, use the filter flag: --filter ${type}`,
              ),
            );
            process.exit(1);
          }

          let rows = Object.values(currencies);
          let title = "Currencies";

          if (type) {
            const lower = type.toLowerCase();
            rows = rows.filter((c) => c.asset_type === lower);
            title = `${lower.charAt(0).toUpperCase() + lower.slice(1)} Currencies`;
          }

          if (opts.filter) {
            const symbolsToMatch = opts.filter
              .split(",")
              .map((s) => s.trim().toUpperCase());
            rows = rows.filter((c) =>
              symbolsToMatch.includes(c.symbol.toUpperCase()),
            );

            if (type) {
              title = `${title} (Filtered: ${symbolsToMatch.join(", ")})`;
            } else {
              title = `Currencies: ${symbolsToMatch.join(", ")}`;
            }

            if (rows.length === 0) {
              console.error(
                `${chalk.red.bold("✖ Error:")} ${chalk.white(`No currency found matching: ${chalk.cyan(opts.filter)}`)}`,
              );
              process.exit(1);
            }
          }

          if (isJsonOutput(opts)) {
            printJson(rows);
          } else {
            printSectionHeader(title);
            printTable(rows, CURRENCY_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("pairs")
    .description("List trading pairs, optionally filtered by symbol")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market pairs                             List all trading pairs
  $ revx market pairs --filter BTC-USD,ETH-USD    Filter by multiple pairs
  $ revx market pairs --json                      Output as JSON`,
    )
    .option(
      "-f, --filter <pairs>",
      "Filter by multiple pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: { filter?: string; json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const pairs = await client.getCurrencyPairs();

          const PAIR_COLUMNS = [
            { header: "Pair", accessor: (r: { symbol: string }) => r.symbol },
            { header: "Base", key: "base" as const },
            { header: "Quote", key: "quote" as const },
            {
              header: "Min Size",
              key: "min_order_size" as const,
              align: "right" as const,
            },
            {
              header: "Max Size",
              key: "max_order_size" as const,
              align: "right" as const,
            },
            {
              header: "Slippage",
              key: "slippage" as const,
              align: "right" as const,
            },
            { header: "Status", key: "status" as const },
          ];

          const normalizePair = (s: string) =>
            s.trim().toUpperCase().replace("-", "/");

          let rows = Object.entries(pairs).map(([symbol, p]) => ({
            symbol,
            ...p,
          }));
          let title = "Trading Pairs";

          if (opts.filter) {
            const filterSet = opts.filter.split(",").map(normalizePair);
            rows = rows.filter((r) =>
              filterSet.includes(r.symbol.toUpperCase()),
            );
            title = `Trading Pairs: ${filterSet.join(", ")}`;

            if (rows.length === 0) {
              console.error(
                `${chalk.red.bold("✖ Error:")} ${chalk.white(`No pair found matching: ${chalk.cyan(opts.filter)}`)}`,
              );
              process.exit(1);
            }
          }

          if (isJsonOutput(opts)) {
            printJson(rows);
          } else {
            printSectionHeader(title);
            printTable(rows, PAIR_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("tickers [symbol]")
    .description("List all tickers or get a specific ticker (e.g. BTC-USD)")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market tickers                        List all tickers
  $ revx market tickers BTC-USD                Get specific BTC-USD ticker
  $ revx market tickers --symbols BTC-USD,ETH  Filter by multiple pairs
  $ revx market tickers --json                 Output as JSON`,
    )
    .option(
      "--symbols <pairs>",
      "Filter by pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string | undefined,
        opts: { symbols?: string; json?: boolean; output?: string },
      ) => {
        try {
          const client = getClient({ requireAuth: true });

          let symbolsToFetch: string[] | undefined = undefined;
          if (symbol) {
            symbolsToFetch = [symbol.trim().toUpperCase()];
          } else if (opts.symbols) {
            symbolsToFetch = opts.symbols
              .split(",")
              .map((s) => s.trim().toUpperCase());
          }

          const result = await client.getTickers(
            symbolsToFetch ? { symbols: symbolsToFetch } : undefined,
          );

          if (isJsonOutput(opts)) {
            printJson(result);
          } else if (symbol && result.data.length === 0) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(`No ticker found for: ${chalk.cyan(symbol.trim().toUpperCase())}`)}`,
            );
            process.exit(1);
          } else if (symbol && result.data.length > 0) {
            const t = result.data[0];
            printSectionHeader(`Ticker: ${t.symbol}`);
            printKeyValue([
              ["Symbol", chalk.white.bold(t.symbol)],
              ["Bid", chalk.green(t.bid)],
              ["Ask", chalk.red(t.ask)],
              ["Mid", chalk.yellow(t.mid)],
              ["Last", chalk.cyan(t.last_price)],
            ]);
          } else {
            printSectionHeader("Market Tickers");
            printTickerTable(result.data);
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
          const cleanSymbol = symbol.trim().toUpperCase();

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

          let startDate = opts.since ? parseTimestamp(opts.since) : undefined;
          let endDate = opts.until ? parseTimestamp(opts.until) : undefined;

          const now = Date.now();
          const intervalMs = intervalMinutes * 60 * 1000;
          const maxHistoryMs = 50000 * intervalMs;
          const oldestAvailableDate = now - maxHistoryMs;

          const fetchEnd = endDate || now;

          if (endDate && endDate < oldestAvailableDate) {
            startDate = oldestAvailableDate;
            endDate = now;
          } else if (
            !startDate ||
            Math.ceil(
              (fetchEnd - (startDate || oldestAvailableDate)) / intervalMs,
            ) > 50000
          ) {
            startDate = oldestAvailableDate;
            endDate = now;
          }

          if (startDate) candleOpts.startDate = startDate;
          if (endDate) candleOpts.endDate = endDate;

          const result = await client.getCandles(cleanSymbol, candleOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader(`Candles: ${cleanSymbol} (${opts.interval})`);
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
          const cleanSymbol = symbol.trim().toUpperCase();
          const result = await client.getOrderBook(cleanSymbol, {
            limit: parsePositiveInt(opts.limit, "limit"),
          });

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader(`Order Book: ${cleanSymbol}`);

            console.log(chalk.red.bold("Asks (Sell):"));
            printTable(result.data.asks.reverse(), [
              { header: "Price", key: "price", align: "right" },
              { header: "Quantity", key: "quantity", align: "right" },
              { header: "Orders", key: "orderCount", align: "right" },
            ]);

            console.log(chalk.green.bold("\nBids (Buy):"));
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
