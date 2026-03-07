import { Command } from "commander";
import type { AccountBalance } from "revolutx-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  type ColumnDef,
} from "../output/formatter.js";

const BALANCE_COLUMNS: ColumnDef<AccountBalance>[] = [
  { header: "Currency", key: "currency" },
  { header: "Available", key: "available", align: "right" },
  { header: "Reserved", key: "reserved", align: "right" },
  { header: "Total", key: "total", align: "right" },
];

export function registerAccountCommand(program: Command): void {
  const account = program
    .command("account")
    .description("Account information")
    .addHelpText(
      "after",
      `
Examples:
  $ revx account balances              Show non-zero balances
  $ revx account balances --all        Include zero balances
  $ revx account balance BTC           Get BTC balance
  $ revx account balances --json       Output as JSON`,
    );

  account
    .command("balances")
    .description("List all account balances")
    .option("-a, --all", "Include zero balances")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: { all?: boolean; json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          let balances = await client.getBalances();

          if (!opts.all) {
            balances = balances.filter((b) => parseFloat(b.total) !== 0);
          }

          if (isJsonOutput(opts)) {
            printJson(balances);
          } else {
            printTable(balances, BALANCE_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  account
    .command("balance <currency>")
    .description("Get balance for a specific currency")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (currency: string, opts: { json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const balances = await client.getBalances();
          const match = balances.find(
            (b) => b.currency.toUpperCase() === currency.toUpperCase(),
          );

          if (!match) {
            console.error(`No balance found for currency: ${currency}`);
            process.exit(1);
          }

          if (isJsonOutput(opts)) {
            printJson(match);
          } else {
            printTable([match], BALANCE_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
