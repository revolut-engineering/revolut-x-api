import { Command } from "commander";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import { isJsonOutput, printJson, printTable, type ColumnDef } from "../output/formatter.js";
type PublicTrade = { id: string; symbol: string; price: string; quantity: string; timestamp: number };

export function registerTradeCommand(program: Command): void {
  const trade = program
    .command("trade")
    .description("Trade history")
    .addHelpText(
      "after",
      `
Examples:
  $ revx trade history BTC-USD                     Recent trades
  $ revx trade history BTC-USD --limit 100         Last 100 trades
  $ revx trade history BTC-USD --json              Output as JSON
  $ revx trade all BTC-USD                         All public trades
  $ revx trade all BTC-USD --since 7d --limit 200  Public trades in last 7 days`,
    );

  trade
    .command("history <symbol>")
    .description("Get private trade history for a pair")
    .option("--start-date <date>", "Start date (ISO, epoch ms, or relative: 7d, 1w, today)")
    .option("--end-date <date>", "End date (ISO, epoch ms, or relative: today, yesterday)")
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
          const queryOpts: {
            startDate?: number;
            endDate?: number;
            limit?: number;
          } = {};
          if (opts.startDate)
            queryOpts.startDate = parseTimestamp(opts.startDate);
          if (opts.endDate) queryOpts.endDate = parseTimestamp(opts.endDate);
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");

          const result = await client.getPrivateTrades(symbol, queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printTable(result.data, [
              { header: "Trade ID", key: "id" },
              { header: "Symbol", key: "symbol" },
              { header: "Side", key: "side" },
              { header: "Price", key: "price", align: "right" },
              { header: "Qty", key: "quantity", align: "right" },
              { header: "Maker", key: "maker" },
              {
                header: "Time",
                accessor: (t) => new Date(t.timestamp).toISOString(),
              },
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  trade
    .command("all <symbol>")
    .description("Get all public trades for a pair")
    .option("--start-date <date>", "Start date (ISO, epoch ms, or relative: 7d, 1w, today)")
    .option("--end-date <date>", "End date (ISO, epoch ms, or relative: today, yesterday)")
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
          const queryOpts: {
            startDate?: number;
            endDate?: number;
            limit?: number;
          } = {};
          if (opts.startDate)
            queryOpts.startDate = parseTimestamp(opts.startDate);
          if (opts.endDate) queryOpts.endDate = parseTimestamp(opts.endDate);
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");

          const result = await client.getAllTrades(symbol, queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
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
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
