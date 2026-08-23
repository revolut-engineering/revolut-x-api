import { Command, Option } from "commander";
import type { AccountBalance } from "@revolut/revolut-x-api";
import chalk from "chalk";
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
  { header: "Staked", key: "staked", align: "right" },
  { header: "Total", key: "total", align: "right" },
];

export function registerAccountCommand(program: Command): void {
  const account = program
    .command("account")
    .description("Account information")
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
  $ revx account balances                              Show non-zero balances
  $ revx account balances BTC                          Get a single currency balance
  $ revx account balances --currencies BTC,ETH,USD     Filter by currencies
  $ revx account balances --all                        Include zero balances
  $ revx account balances --json                       Output as JSON`,
    );

  account
    .command("balances")
    .description("View account balance or list all balances")
    .argument("[currency]", "Single currency to look up, e.g. BTC")
    .addHelpText(
      "after",
      `
Examples:
  $ revx account balances                              Show non-zero balances
  $ revx account balances --all                        List absolutely all balances
  $ revx account balances BTC                          Get specific BTC balance
  $ revx account balances --currencies BTC,ETH,USD     Filter by currencies
  $ revx account balances --json                       Output as JSON`,
    )
    .option("-a, --all", "Include zero balances")
    .option(
      "-c, --currencies <list>",
      "Filter by currencies (comma-separated). Zero balances of the listed currencies are always shown, so --all is not needed",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        currency: string | undefined,
        opts: {
          all?: boolean;
          currencies?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          let balances = await client.getBalances();

          if (currency) {
            const match = balances.find(
              (b) => b.currency.toUpperCase() === currency.toUpperCase(),
            );

            if (!match) {
              console.error(
                `${chalk.red.bold("✖ Error:")} ${chalk.white(`No balance found for currency: ${chalk.cyan(currency.toUpperCase())}`)}`,
              );
              process.exit(1);
            }

            if (isJsonOutput(opts)) {
              printJson(match);
            } else {
              console.log(
                chalk.cyan.bold(`\n❖ Balance: ${match.currency.toUpperCase()}`),
              );
              console.log(chalk.dim("─".repeat(50)));
              printTable([match], BALANCE_COLUMNS);
            }
            return;
          }

          if (opts.currencies) {
            const filter = opts.currencies
              .split(",")
              .map((c) => c.trim().toUpperCase());
            balances = balances.filter((b) =>
              filter.includes(b.currency.toUpperCase()),
            );
          } else if (!opts.all) {
            balances = balances.filter((b) => parseFloat(b.total) !== 0);
          }

          if (isJsonOutput(opts)) {
            printJson(balances);
          } else {
            if (balances.length === 0) {
              console.log(chalk.yellow("\n! No balances found."));
              if (!opts.all) {
                console.log(
                  chalk.gray("  ↳ Use '--all' to include zero balances.\n"),
                );
              }
              return;
            }
            console.log(chalk.cyan.bold("\n❖ Account Balances"));
            console.log(chalk.dim("─".repeat(50)));
            printTable(balances, BALANCE_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
