import { Command, Option } from "commander";
import chalk from "chalk";
import type { Ticker, Candle } from "@revolut/revolut-x-api";
import {
  ORDER_BOOK_DEFAULT_DEPTH,
  ORDER_BOOK_MAX_DEPTH,
} from "@revolut/revolut-x-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { candleIntervalMinutes } from "../util/candle-intervals.js";
import {
  resolveDateWindow,
  parsePositiveInt,
  parseIntInRange,
} from "../util/parse.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  formatLocalDateTime,
  LOCAL_TIME_NOTE,
  type ColumnDef,
} from "../output/formatter.js";

const DEFAULT_CANDLES = 100;
const MAX_CANDLES = 50000;

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
  $ revx market currencies                            List all currencies
  $ revx market currencies fiat                       List fiat currencies only
  $ revx market currencies crypto                     List crypto currencies only
  $ revx market currencies --filter BTC,USD           Get specific currencies by code
  $ revx market pairs                                 List all trading pairs
  $ revx market pairs --filter BTC-USD,ETH-USD        Filter by multiple pairs
  $ revx market tickers                               List all tickers
  $ revx market tickers BTC-USD                       Get BTC-USD ticker
  $ revx market candles BTC-USD                       Get the last 100 hourly candles
  $ revx market candles BTC-USD --interval 5m         Get 5-minute candles
  $ revx market candles BTC-USD --since 7d --until today
  $ revx market orderbook BTC-USD                     Get order book (50 levels per side)
  $ revx market orderbook BTC-USD --limit 20          Get order book (20 levels per side)
  $ revx market orderbook BTC-USD --limit 192         Get the deepest book available`,
    );

  market
    .command("currencies")
    .description(
      "List supported currencies, optionally filtered by type (fiat|crypto) or currency codes",
    )
    .argument("[type]", "Filter by asset type: fiat or crypto")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market currencies                        List all currencies
  $ revx market currencies fiat                   List fiat currencies only
  $ revx market currencies crypto                 List crypto currencies only
  $ revx market currencies --filter BTC,USD       Get specific currencies by code
  $ revx market currencies --json                 Output as JSON`,
    )
    .option(
      "-f, --filter <codes>",
      "Filter by currency codes (comma-separated, e.g., BTC,USD)",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        type: string | undefined,
        opts: { filter?: string; json?: boolean; output?: string },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const currencies = await client.getCurrencies();

          const CURRENCY_COLUMNS = [
            { header: "Code", key: "code" as const },
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
                `  ↳ To search for a currency, use the filter flag: --filter ${type}`,
              ),
            );
            process.exit(1);
          }

          let rows = Object.entries(currencies).map(([code, currency]) => ({
            code,
            ...currency,
          }));
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
              symbolsToMatch.includes(c.code.toUpperCase()),
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
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
              header: "Size Step",
              key: "base_step" as const,
              align: "right" as const,
            },
            {
              header: "Price Step",
              key: "quote_step" as const,
              align: "right" as const,
            },
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
    .command("tickers")
    .alias("ticker")
    .description("List all tickers or get a specific ticker (e.g. BTC-USD)")
    .argument("[symbol]", "Trading pair to fetch, e.g. BTC-USD")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market tickers                             List all tickers
  $ revx market tickers BTC-USD                     Get specific BTC-USD ticker
  $ revx market ticker BTC-USD                      Same, using the singular alias
  $ revx market tickers --symbols BTC-USD,ETH-USD   Filter by multiple pairs
  $ revx market tickers --json                      Output as JSON`,
    )
    .option(
      "--symbols <pairs>",
      "Filter by pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
              ["Index", chalk.magenta(t.index_price)],
              ["Last", chalk.cyan(t.last_price)],
              ["Low 24h", chalk.white(t.low_24h)],
              ["High 24h", chalk.white(t.high_24h)],
              ["Change 24h", chalk.white(t.price_change_24h)],
              ["Volume 24h", chalk.white(t.volume_24h)],
              ["Quote Vol 24h", chalk.white(t.quote_volume_24h)],
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
    .command("candles")
    .description("Get OHLCV candles for a pair")
    .argument("<symbol>", "Trading pair, e.g. BTC-USD")
    .addHelpText(
      "after",
      `
Examples:
  $ revx market candles BTC-USD                       Last 100 hourly candles (default)
  $ revx market candles BTC-USD --interval 5m         5-minute candles by alias
  $ revx market candles BTC-USD --interval 5          Same, in minutes
  $ revx market candles BTC-USD --since 7d            Last 7 days
  $ revx market candles BTC-USD --since 7d --until yesterday
  $ revx market candles BTC-USD --json                Output as JSON

Without --since, the last 100 candles are shown. At most 50000 candles are returned,
so a longer range keeps its end and starts later.`,
    )
    .option(
      "--interval <value>",
      "Candle interval: alias (1m,5m,15m,30m,1h,4h,1d,2d,4d,1w,2w,4w) or its equivalent in minutes (1,5,15,30,60,240,1440,2880,5760,10080,20160,40320)",
      "1h",
    )
    .option(
      "--since <date>",
      "Start time in local time (ISO date, epoch ms, or relative: 7d, 1w, 4h, today)",
    )
    .option(
      "--until <date>",
      "End time in local time (ISO date, epoch ms, or relative: today, yesterday)",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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

          const intervalMinutes =
            candleIntervalMinutes(opts.interval) ??
            parsePositiveInt(opts.interval, "interval");

          const candleOpts: {
            interval?: number | string;
            startDate?: number;
            endDate?: number;
          } = {};

          candleOpts.interval = intervalMinutes;

          const intervalMs = intervalMinutes * 60 * 1000;
          const dates = resolveDateWindow(
            opts.since,
            opts.until,
            DEFAULT_CANDLES * intervalMs,
            ["--since", "--until"],
          );
          const earliestStart = dates.end - MAX_CANDLES * intervalMs;
          const capped = dates.start < earliestStart;
          candleOpts.startDate = capped ? earliestStart : dates.start;
          candleOpts.endDate = dates.end;
          const cappedNote = `Only the last ${MAX_CANDLES} candles of that range are shown.`;

          const result = await client.getCandles(cleanSymbol, candleOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
            if (capped) console.error(cappedNote);
          } else {
            printSectionHeader(`Candles: ${cleanSymbol} (${opts.interval})`);
            if (capped) console.log(chalk.dim(`  ${cappedNote}`));
            const columns: ColumnDef<Candle>[] = [
              {
                header: "Time",
                accessor: (c) => formatLocalDateTime(c.start),
              },
              { header: "Open", key: "open", align: "right" },
              { header: "High", key: "high", align: "right" },
              { header: "Low", key: "low", align: "right" },
              { header: "Close", key: "close", align: "right" },
              { header: "Volume", key: "volume", align: "right" },
            ];
            if (result.data.length > 0) {
              console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
            }
            printTable(result.data, columns);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  market
    .command("orderbook")
    .description("Get order book for a pair")
    .argument("<symbol>", "Trading pair, e.g. BTC-USD")
    .option(
      "--limit <n>",
      `Depth per side, 1-${ORDER_BOOK_MAX_DEPTH}`,
      String(ORDER_BOOK_DEFAULT_DEPTH),
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        symbol: string,
        opts: { limit: string; json?: boolean; output?: string },
      ) => {
        const limit = parseIntInRange(
          opts.limit,
          "--limit",
          1,
          ORDER_BOOK_MAX_DEPTH,
        );

        try {
          const client = getClient({ requireAuth: true });
          const cleanSymbol = symbol.trim().toUpperCase();
          const result = await client.getOrderBook(cleanSymbol, { limit });

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader(`Order Book: ${cleanSymbol}`);

            console.log(chalk.red.bold("Asks (Sell):"));
            printTable(result.data.asks, [
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
    { header: "Index", key: "index_price", align: "right" },
    { header: "Last", key: "last_price", align: "right" },
    { header: "Low 24h", key: "low_24h", align: "right" },
    { header: "High 24h", key: "high_24h", align: "right" },
    { header: "Change 24h", key: "price_change_24h", align: "right" },
    { header: "Volume 24h", key: "volume_24h", align: "right" },
    { header: "Quote Vol 24h", key: "quote_volume_24h", align: "right" },
  ]);
}
