import { Command, Option } from "commander";
import chalk from "chalk";
import {
  type Transaction,
  type TransactionDetailLeg,
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
  printKeyValue,
  formatLocalDateTime,
  LOCAL_TIME_NOTE,
  type ColumnDef,
} from "../output/formatter.js";

const TRANSACTION_TYPES = [
  "buy",
  "sell",
  "receive",
  "send",
  "stake",
  "un_stake",
  "reward",
] as const;

const TRANSACTION_STATUSES = [
  "pending",
  "completed",
  "cancelled",
  "failed",
  "reverted",
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

function formatAccount(
  account: TransactionDetailLeg["account"],
): string | undefined {
  if (!account) return undefined;
  const parts = [account.display_name, account.type].filter(Boolean);
  if (account.crypto_address) parts.push(account.crypto_address);
  return parts.join(" · ");
}

function pushLegRows(
  rows: [string, string][],
  label: string,
  leg: TransactionDetailLeg | undefined,
): void {
  if (!leg) return;
  rows.push([chalk.cyan.bold(`\n❖ ${label}`), ""]);
  rows.push([chalk.gray("  ↳ Amount"), `${leg.amount} ${leg.currency}`]);
  if (leg.fee)
    rows.push([
      chalk.gray("  ↳ Fee"),
      `${leg.fee}${leg.fee_currency ? ` ${leg.fee_currency}` : ""}`,
    ]);
  const account = formatAccount(leg.account);
  if (account) rows.push([chalk.gray("  ↳ Account"), account]);
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
    .description(
      "Transaction history (trades, transfers, staking, and rewards)",
    )
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
  $ revx transaction list                                Recent transactions
  $ revx transaction list --limit 100                    Last 100 transactions
  $ revx transaction list --start-date 7d               Transactions in last 7 days
  $ revx transaction list --types buy,receive            Filter by type
  $ revx transaction list --statuses completed           Filter by status
  $ revx transaction list --currencies BTC,USD           Filter by currency
  $ revx transaction list --json                         Output as JSON
  $ revx transaction get <transaction-id>                Full details of one transaction

Without --start-date, the 30 days ending at --end-date (now by default) are returned.`,
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
    .option(
      "--types <types>",
      `Filter by type (comma-separated: ${TRANSACTION_TYPES.join(",")})`,
    )
    .option(
      "--statuses <statuses>",
      `Filter by status (comma-separated: ${TRANSACTION_STATUSES.join(",")})`,
    )
    .option(
      "--currencies <currencies>",
      "Filter by currency (comma-separated, e.g. BTC,USD)",
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
                    formatFlow(t.source?.amount, t.source?.currency, "-"),
                  align: "right",
                },
                {
                  header: "Destination Amount",
                  accessor: (t) =>
                    formatFlow(
                      t.destination?.amount,
                      t.destination?.currency,
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

  transaction
    .command("get")
    .description("Get details of a specific transaction")
    .argument(
      "<transaction-id>",
      "Transaction ID as shown by `revx transaction list`",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        transactionId: string,
        opts: { json?: boolean; output?: string },
      ) => {
        try {
          const client = getClient({ requireAuth: true });
          const t = await client.getTransaction(transactionId);

          if (isJsonOutput(opts)) {
            printJson(t);
          } else {
            printSectionHeader("Transaction Details");
            console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));

            const rows: [string, string][] = [
              ["ID", chalk.white.bold(t.id)],
              ["Type", t.type],
              ["Status", formatStatus(t)],
            ];

            pushLegRows(rows, "Source", t.source);
            pushLegRows(rows, "Destination", t.destination);

            if (t.description) rows.push(["Description", t.description]);
            if (t.order_id) rows.push(["Order ID", t.order_id]);
            if (t.crypto_transaction_hash)
              rows.push(["Crypto Transaction Hash", t.crypto_transaction_hash]);
            if (t.network) rows.push(["Network", t.network]);

            rows.push(["Created", formatLocalDateTime(t.created_date)]);
            if (t.processed_date !== undefined)
              rows.push(["Processed", formatLocalDateTime(t.processed_date)]);

            printKeyValue(rows);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function formatStatus(t: Pick<Transaction, "status">): string {
  const s = String(t.status);
  if (s === "completed") return chalk.green("completed");
  if (s === "pending") return chalk.yellow("pending");
  if (s === "failed") return chalk.red(s);
  if (s === "canceled" || s === "cancelled" || s === "reverted")
    return chalk.gray(s);
  return s;
}
