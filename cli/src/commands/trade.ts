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

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
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
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: {
          startDate?: string;
          endDate?: string;
          limit?: string;
          cursor?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const cleanSymbol = symbol.trim().toUpperCase();
          const queryOpts: {
            startDate?: number;
            endDate?: number;
            limit?: number;
            cursor?: string;
          } = {};

          if (opts.startDate)
            queryOpts.startDate = parseTimestamp(opts.startDate);
          if (opts.endDate) queryOpts.endDate = parseTimestamp(opts.endDate);
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");
          if (opts.cursor) queryOpts.cursor = opts.cursor;

          const result = await client.getPrivateTrades(cleanSymbol, queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader(`Private Trades: ${cleanSymbol}`);
            if (result.data.length === 0) {
              console.log(chalk.gray("No private trades found.\n"));
            } else {
              printTable(result.data, [
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
              if (
                "cursor" in result &&
                (result as { cursor?: string }).cursor
              ) {
                console.log(
                  chalk.gray(
                    `\n  Cursor: ${(result as { cursor?: string }).cursor}`,
                  ),
                );
              }
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
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        opts: {
          startDate?: string;
          endDate?: string;
          limit?: string;
          cursor?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const cleanSymbol = symbol.trim().toUpperCase();
          const queryOpts: {
            startDate?: number;
            endDate?: number;
            limit?: number;
            cursor?: string;
          } = {};

          if (opts.startDate)
            queryOpts.startDate = parseTimestamp(opts.startDate);
          if (opts.endDate) queryOpts.endDate = parseTimestamp(opts.endDate);
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");
          if (opts.cursor) queryOpts.cursor = opts.cursor;

          const result = await client.getAllTrades(cleanSymbol, queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader(`Public Trades: ${cleanSymbol}`);
            if (result.data.length === 0) {
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
              printTable(result.data, columns);
              if (
                "cursor" in result &&
                (result as { cursor?: string }).cursor
              ) {
                console.log(
                  chalk.gray(
                    `\n  Cursor: ${(result as { cursor?: string }).cursor}`,
                  ),
                );
              }
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
