import { Command } from "commander";
import chalk from "chalk";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  type ColumnDef,
} from "../output/formatter.js";
import { Trade } from "api-k9x2a";

type PublicTrade = {
  id: string;
  symbol: string;
  price: string;
  quantity: string;
  timestamp: number;
};

function formatPeriod(start?: number, end?: number): string {
  if (start && end) {
    return `Period: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`;
  }
  if (start) {
    return `Period: Since ${new Date(start).toISOString()}`;
  }
  if (end) {
    return `Period: Up to ${new Date(end).toISOString()}`;
  }
  return "Period: Default / Recent";
}

function printSectionHeader(title: string, subtitle?: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  if (subtitle) {
    console.log(chalk.gray(`  ${subtitle}`));
  }
  console.log(chalk.dim("─".repeat(50)));
}

export function registerTradeCommand(program: Command): void {
  const trade = program
    .command("trade")
    .description("Trade history and public market trades")
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
  $ revx trade private BTC-USD                     Recent personal trades
  $ revx trade private BTC-USD --limit 100         Last 100 personal trades
  $ revx trade private BTC-USD --json              Output as JSON
  $ revx trade public BTC-USD                      Recent public trades
  $ revx trade public BTC-USD --since 7d           Public trades in last 7 days`,
    );

  trade
    .command("private <symbol>")
    .alias("history")
    .description("Get your private trade history for a pair")
    .option(
      "--start-date <date>",
      "Start date (ISO, epoch ms, or relative: 7d, 1w, today)",
    )
    .option(
      "--end-date <date>",
      "End date (ISO, epoch ms, or relative: today, yesterday)",
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: {
          startDate?: string;
          endDate?: string;
          limit?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const cleanSymbol = symbol.trim().toUpperCase();
          const userLimit = opts.limit
            ? parsePositiveInt(opts.limit, "limit")
            : undefined;

          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const endTimeMs = opts.endDate
            ? parseTimestamp(opts.endDate)
            : Date.now();
          let currentStart = opts.startDate
            ? parseTimestamp(opts.startDate)
            : endTimeMs - THIRTY_DAYS_MS;

          const allTrades: Trade[] = [];

          while (currentStart < endTimeMs) {
            const currentEndMs = Math.min(
              currentStart + THIRTY_DAYS_MS,
              endTimeMs,
            );
            let cursor: string | undefined = undefined;

            while (true) {
              const result = await client.getPrivateTrades(cleanSymbol, {
                startDate: currentStart,
                endDate: currentEndMs,
                cursor,
              });

              if (result.data.length > 0) {
                if (userLimit !== undefined) {
                  allTrades.push(
                    ...result.data.slice(0, userLimit - allTrades.length),
                  );
                } else {
                  allTrades.push(...result.data);
                }
              }

              if (userLimit !== undefined && allTrades.length >= userLimit)
                break;

              cursor = result.metadata?.next_cursor;
              if (!cursor) break;
            }

            if (userLimit !== undefined && allTrades.length >= userLimit) break;
            currentStart = currentEndMs;
          }

          if (isJsonOutput(opts)) {
            printJson({ data: allTrades });
          } else {
            const periodText = formatPeriod(
              opts.startDate ? parseTimestamp(opts.startDate) : undefined,
              opts.endDate ? parseTimestamp(opts.endDate) : undefined,
            );
            printSectionHeader(`Private Trades: ${cleanSymbol}`, periodText);

            if (allTrades.length === 0) {
              console.log(chalk.gray("No private trades found.\n"));
            } else {
              printTable(allTrades, [
                { header: "Trade ID", key: "id" },
                { header: "Symbol", key: "symbol" },
                {
                  header: "Side",
                  accessor: (t: Trade) =>
                    t.side?.toUpperCase() === "BUY"
                      ? chalk.green("BUY")
                      : chalk.red("SELL"),
                },
                { header: "Price", key: "price", align: "right" },
                { header: "Qty", key: "quantity", align: "right" },
                { header: "Maker", key: "maker" },
                {
                  header: "Time",
                  accessor: (t) => new Date(t.timestamp).toISOString(),
                },
              ]);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  trade
    .command("public <symbol>")
    .alias("all")
    .description("Get all public trades for a pair")
    .option(
      "--start-date <date>",
      "Start date (ISO, epoch ms, or relative: 7d, 1w, today)",
    )
    .option(
      "--end-date <date>",
      "End date (ISO, epoch ms, or relative: today, yesterday)",
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: {
          startDate?: string;
          endDate?: string;
          limit?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const cleanSymbol = symbol.trim().toUpperCase();
          const userLimit = opts.limit
            ? parsePositiveInt(opts.limit, "limit")
            : undefined;

          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const endTimeMs = opts.endDate
            ? parseTimestamp(opts.endDate)
            : Date.now();
          let currentStart = opts.startDate
            ? parseTimestamp(opts.startDate)
            : endTimeMs - THIRTY_DAYS_MS;

          const allTrades: PublicTrade[] = [];

          while (currentStart < endTimeMs) {
            const currentEndMs = Math.min(
              currentStart + THIRTY_DAYS_MS,
              endTimeMs,
            );
            let cursor: string | undefined = undefined;

            while (true) {
              const result = await client.getAllTrades(cleanSymbol, {
                startDate: currentStart,
                endDate: currentEndMs,
                cursor,
              });

              if (result.data.length > 0) {
                if (userLimit !== undefined) {
                  allTrades.push(
                    ...result.data.slice(0, userLimit - allTrades.length),
                  );
                } else {
                  allTrades.push(...result.data);
                }
              }

              if (userLimit !== undefined && allTrades.length >= userLimit)
                break;

              cursor = result.metadata?.next_cursor;
              if (!cursor) break;
            }

            if (userLimit !== undefined && allTrades.length >= userLimit) break;
            currentStart = currentEndMs;
          }

          if (isJsonOutput(opts)) {
            printJson({ data: allTrades });
          } else {
            const periodText = formatPeriod(
              opts.startDate ? parseTimestamp(opts.startDate) : undefined,
              opts.endDate ? parseTimestamp(opts.endDate) : undefined,
            );
            printSectionHeader(`Public Trades: ${cleanSymbol}`, periodText);

            if (allTrades.length === 0) {
              console.log(chalk.gray("No public trades found.\n"));
            } else {
              const columns: ColumnDef<PublicTrade>[] = [
                { header: "Trade ID", key: "id" },
                { header: "Symbol", key: "symbol" },
                { header: "Price", key: "price", align: "right" },
                { header: "Qty", key: "quantity", align: "right" },
                {
                  header: "Time",
                  accessor: (t) => new Date(t.timestamp).toISOString(),
                },
              ];
              printTable(allTrades, columns);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
