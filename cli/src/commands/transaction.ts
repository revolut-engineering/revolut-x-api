import { Command } from "commander";
import chalk from "chalk";
import {
  type Transaction,
  paginateWithDynamicWindows,
  TRANSACTIONS_API_LIMIT,
} from "@revolut/revolut-x-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  formatLocalDateTime,
  LOCAL_TIME_NOTE,
  type ColumnDef,
} from "../output/formatter.js";

const TRANSACTION_TYPES = ["buy", "sell", "send", "receive"] as const;

const TRANSACTION_STATUSES = [
  "pending",
  "completed",
  "rejected",
  "failed",
  "cancelled",
] as const;

function formatPeriod(start?: number, end?: number): string {
  if (start && end) {
    return `Period: ${formatLocalDateTime(start)} to ${formatLocalDateTime(end)}`;
  }
  if (start) {
    return `Period: Since ${formatLocalDateTime(start)}`;
  }
  if (end) {
    return `Period: Up to ${formatLocalDateTime(end)}`;
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

function formatFlow(
  amount: string | undefined,
  currency: string | undefined,
  sign: "+" | "-",
): string {
  if (!amount || !currency) return "";
  const unsignedAmount = amount.replace(/^[+-]/, "");
  return `${sign}${unsignedAmount} ${currency}`;
}

function parseList<T extends string>(
  value: string | undefined,
  validValues: readonly T[],
  fieldName: string,
): T[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = items.filter((s) => !validValues.includes(s as T));
  if (invalid.length > 0) {
    console.error(
      `${chalk.red.bold("✖ Error:")} ${chalk.white(`Invalid ${fieldName}: ${invalid.join(", ")}. Valid values: ${validValues.join(", ")}`)}`,
    );
    process.exit(1);
  }
  return items as T[];
}

export function registerTransactionCommand(program: Command): void {
  const transaction = program
    .command("transaction")
    .description("Transaction history (buys, sells, sends, and receives)")
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
  $ revx transaction list                               Recent transactions
  $ revx transaction list --limit 100                    Last 100 transactions
  $ revx transaction list --start-date 7d                Transactions in last 7 days
  $ revx transaction list --types buy,receive            Filter by type
  $ revx transaction list --statuses completed           Filter by status
  $ revx transaction list --currencies BTC,USD           Filter by currency
  $ revx transaction list --json                         Output as JSON`,
    );

  transaction
    .command("list")
    .description("List your transactions")
    .option(
      "--start-date <date>",
      "Start date in local time (ISO, epoch ms, or relative: 7d, 1w, today)",
    )
    .option(
      "--end-date <date>",
      "End date in local time (ISO, epoch ms, or relative: today, yesterday)",
    )
    .option("--types <types>", "Filter by transaction type (comma-separated)")
    .option(
      "--statuses <statuses>",
      "Filter by transaction status (comma-separated)",
    )
    .option("--currencies <currencies>", "Filter by currency (comma-separated)")
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        startDate?: string;
        endDate?: string;
        types?: string;
        statuses?: string;
        currencies?: string;
        limit?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const userLimit = opts.limit
            ? parsePositiveInt(opts.limit, "limit")
            : undefined;

          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const endTimeMs = opts.endDate
            ? parseTimestamp(opts.endDate)
            : Date.now();
          const startTimeMs = opts.startDate
            ? parseTimestamp(opts.startDate)
            : endTimeMs - THIRTY_DAYS_MS;

          const types = parseList(opts.types, TRANSACTION_TYPES, "types");
          const statuses = parseList(
            opts.statuses,
            TRANSACTION_STATUSES,
            "statuses",
          );
          const currencies = opts.currencies
            ? opts.currencies
                .split(",")
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean)
            : undefined;

          const allTransactions = await paginateWithDynamicWindows<Transaction>(
            {
              fetchPage: (startDate, endDate, cursor, apiLimit) =>
                client.getTransactions({
                  startDate,
                  endDate,
                  types,
                  statuses,
                  currencies,
                  cursor,
                  limit: apiLimit,
                }),
              startDate: startTimeMs,
              endDate: endTimeMs,
              apiLimit: TRANSACTIONS_API_LIMIT,
              userLimit,
            },
          );

          if (isJsonOutput(opts)) {
            printJson({ data: allTransactions });
          } else {
            const periodText = formatPeriod(
              opts.startDate ? parseTimestamp(opts.startDate) : undefined,
              opts.endDate ? parseTimestamp(opts.endDate) : undefined,
            );
            printSectionHeader("Transactions", periodText);

            if (allTransactions.length === 0) {
              console.log(chalk.gray("No transactions found.\n"));
            } else {
              console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
              printTable(allTransactions, [
                { header: "ID", key: "id" },
                { header: "Type", key: "type" },
                { header: "Status", accessor: formatStatus },
                {
                  header: "Source Amount",
                  accessor: (t) =>
                    formatFlow(t.source_amount, t.source_currency, "-"),
                  align: "right",
                },
                {
                  header: "Destination Amount",
                  accessor: (t) =>
                    formatFlow(
                      t.destination_amount,
                      t.destination_currency,
                      "+",
                    ),
                  align: "right",
                },
                {
                  header: "Created",
                  accessor: (t) => formatLocalDateTime(t.created_date),
                },
                {
                  header: "Processed",
                  accessor: (t) =>
                    t.processed_date !== undefined
                      ? formatLocalDateTime(t.processed_date)
                      : "",
                },
              ] satisfies ColumnDef<Transaction>[]);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function formatStatus(t: Transaction): string {
  const s = String(t.status);
  if (s === "completed") return chalk.green("completed");
  if (s === "pending") return chalk.yellow("pending");
  if (s === "rejected" || s === "failed") return chalk.red(s);
  if (s === "cancelled") return chalk.gray("cancelled");
  return s;
}
