import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PAGINATED_DATA_MAX_LIMIT,
  TRANSACTION_ACCOUNT_TYPES,
  TRANSACTIONS_API_LIMIT,
  paginateWithDynamicWindows,
  type Transaction,
  type TransactionDetails,
  type TransactionDetailLeg,
} from "@revolut/revolut-x-api";
import {
  formatDate,
  handleApiError,
  parseDateRange,
  textResult,
} from "../shared/_helpers.js";

const transactionAccountTypeSchema = z.enum(TRANSACTION_ACCOUNT_TYPES);

function formatFlow(
  amount: string | undefined,
  currency: string | undefined,
  sign: "+" | "-",
  accountType?: string,
): string | undefined {
  if (!amount || !currency) return undefined;
  const unsignedAmount = amount.replace(/^[+-]/, "");
  const flow = `${sign}${unsignedAmount} ${currency}`;
  return accountType ? `${flow} (${accountType})` : flow;
}

function formatLegDetails(
  label: string,
  leg: TransactionDetailLeg | undefined,
  sign: "+" | "-",
): string {
  if (!leg) return "";
  let text = `  ${label}: ${formatFlow(leg.amount, leg.currency, sign)}\n`;
  if (leg.fee)
    text += `    Fee: ${leg.fee}${leg.fee_currency ? ` ${leg.fee_currency}` : ""}\n`;
  if (leg.account) {
    const accountParts = [leg.account.display_name, leg.account.type].filter(
      Boolean,
    );
    if (leg.account.crypto_address)
      accountParts.push(leg.account.crypto_address);
    text += `    Account: ${accountParts.join(" · ")}\n`;
  }
  return text;
}

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    "get_transactions",
    {
      title: "Get Transactions",
      description:
        "Get your transaction history, including trades, transfers, staking, and rewards. " +
        "Each transaction may contain a source amount, a destination amount, or both: " +
        "buys and sells show both legs, sends and stakes only a source, " +
        "and receives, rewards, and un_stakes only a destination. " +
        "Each leg reports its account `type` — revolut, revolut_x, external_fiat, or external_crypto " +
        "(account names and crypto addresses are available via get_transaction). " +
        "Defaults to the last 30 days and handles pagination internally.",
      inputSchema: {
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of the date range in your local timezone. Accepts ISO format or a relative value such as '7d'. Defaults to 30 days before end_date.",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of the date range in your local timezone. Accepts ISO format or a relative value. Defaults to now.",
          ),
        types: z
          .array(
            z.enum([
              "buy",
              "sell",
              "receive",
              "send",
              "stake",
              "un_stake",
              "reward",
            ]),
          )
          .optional()
          .describe(
            "Filter by transaction type: buy, sell, receive, send, stake, un_stake, or reward.",
          ),
        statuses: z
          .array(
            z.enum(["pending", "completed", "cancelled", "failed", "reverted"]),
          )
          .optional()
          .describe(
            "Filter by transaction status: pending, completed, cancelled, failed, or reverted.",
          ),
        currencies: z
          .array(z.string())
          .optional()
          .describe('Filter by currencies, e.g. ["BTC", "USD"].'),
        totalLimit: z
          .number()
          .int()
          .positive()
          .max(PAGINATED_DATA_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum total transactions to return. Max is ${PAGINATED_DATA_MAX_LIMIT}.`,
          ),
      },
      outputSchema: {
        transactions: z.array(
          z.object({
            id: z.string(),
            status: z.enum([
              "pending",
              "completed",
              "cancelled",
              "failed",
              "reverted",
            ]),
            type: z.enum([
              "buy",
              "sell",
              "receive",
              "send",
              "stake",
              "un_stake",
              "reward",
            ]),
            source: z
              .object({
                amount: z.string(),
                currency: z.string(),
                account: z
                  .object({
                    type: transactionAccountTypeSchema,
                  })
                  .optional(),
              })
              .optional(),
            destination: z
              .object({
                amount: z.string(),
                currency: z.string(),
                account: z
                  .object({
                    type: transactionAccountTypeSchema,
                  })
                  .optional(),
              })
              .optional(),
            created_date: z.number(),
            processed_date: z.number().optional(),
          }),
        ),
      },
      annotations: {
        title: "Get Transactions",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      start_date,
      end_date,
      types,
      statuses,
      currencies,
      totalLimit,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const dates = parseDateRange(start_date, end_date, {
        defaultWindowMs: 30 * 24 * 60 * 60 * 1000,
        endDefaultsToNow: true,
      });
      if ("error" in dates) return dates.error;

      const normalizedCurrencies = currencies
        ?.map((currency) => currency.trim().toUpperCase())
        .filter(Boolean);
      let transactions: Transaction[];

      try {
        const client = getRevolutXClient();
        transactions = await paginateWithDynamicWindows<Transaction>({
          fetchPage: (startDate, endDate, cursor, apiLimit) =>
            client.getTransactions({
              startDate,
              endDate,
              types,
              statuses,
              currencies: normalizedCurrencies,
              cursor,
              limit: apiLimit,
            }),
          startDate: dates.parsedStartDate,
          endDate: dates.parsedEndDate,
          apiLimit: TRANSACTIONS_API_LIMIT,
          userLimit: totalLimit,
        });
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) {
          return {
            ...handled,
            structuredContent: { transactions: [] },
          };
        }
        throw error;
      }

      if (!transactions.length) {
        return {
          ...textResult(
            `No transactions found for ${formatDate(dates.parsedStartDate)} to ${formatDate(dates.parsedEndDate)}.`,
          ),
          structuredContent: { transactions },
        };
      }

      const lines = [`Transactions (${transactions.length} returned):\n`];
      for (const transaction of transactions) {
        const sourceAmount = formatFlow(
          transaction.source?.amount,
          transaction.source?.currency,
          "-",
          transaction.source?.account?.type,
        );
        const destinationAmount = formatFlow(
          transaction.destination?.amount,
          transaction.destination?.currency,
          "+",
          transaction.destination?.account?.type,
        );
        lines.push(
          `  ID: ${transaction.id}\n` +
            `  Type: ${transaction.type}\n` +
            `  Status: ${transaction.status}\n` +
            (sourceAmount ? `  Source Amount: ${sourceAmount}\n` : "") +
            (destinationAmount
              ? `  Destination Amount: ${destinationAmount}\n`
              : "") +
            `  Created: ${formatDate(transaction.created_date)}\n` +
            (transaction.processed_date !== undefined
              ? `  Processed: ${formatDate(transaction.processed_date)}\n`
              : ""),
        );
      }

      lines.push(
        `Complete results for ${formatDate(dates.parsedStartDate)} to ${formatDate(dates.parsedEndDate)}.`,
      );
      return {
        ...textResult(lines.join("\n")),
        structuredContent: { transactions },
      };
    },
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get Transaction by ID",
      description:
        "Get the full details of a single transaction by its ID. " +
        "Unlike get_transactions, this includes per-leg fees (`fee`, `fee_currency` — shown on at most one leg, the leg paid in the fee's currency), " +
        "account details (`account` with `type`, optional `display_name`, and optional `crypto_address`), " +
        "and — when present — `order_id`, `crypto_transaction_hash`, `network`, and `description`. " +
        "Receives and sends show both legs here (the list shows only one); " +
        "stakes show only a source and un_stakes and rewards only a destination. " +
        "Stake, un_stake, and reward transactions, as well as external top-ups, never show fees. " +
        "Use it to answer fee, counterparty, or on-chain questions about a specific transaction.",
      inputSchema: {
        transaction_id: z
          .string()
          .describe("The transaction ID to look up (from get_transactions)."),
      },
      outputSchema: {
        transaction: z
          .object({
            id: z.string(),
            status: z.enum([
              "pending",
              "completed",
              "cancelled",
              "failed",
              "reverted",
            ]),
            type: z.enum([
              "buy",
              "sell",
              "receive",
              "send",
              "stake",
              "un_stake",
              "reward",
            ]),
            source: z
              .object({
                amount: z.string(),
                currency: z.string(),
                fee: z.string().optional(),
                fee_currency: z.string().optional(),
                account: z
                  .object({
                    type: transactionAccountTypeSchema,
                    display_name: z.string().optional(),
                    crypto_address: z.string().optional(),
                  })
                  .optional(),
              })
              .optional(),
            destination: z
              .object({
                amount: z.string(),
                currency: z.string(),
                fee: z.string().optional(),
                fee_currency: z.string().optional(),
                account: z
                  .object({
                    type: transactionAccountTypeSchema,
                    display_name: z.string().optional(),
                    crypto_address: z.string().optional(),
                  })
                  .optional(),
              })
              .optional(),
            order_id: z.string().optional(),
            crypto_transaction_hash: z.string().optional(),
            network: z.string().optional(),
            description: z.string().optional(),
            created_date: z.number(),
            processed_date: z.number().optional(),
          })
          .nullable(),
      },
      annotations: {
        title: "Get Transaction by ID",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ transaction_id }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let transaction: TransactionDetails;
      try {
        transaction = await getRevolutXClient().getTransaction(transaction_id);
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) {
          return {
            ...handled,
            structuredContent: { transaction: null },
          };
        }
        throw error;
      }

      const text =
        `Transaction ${transaction.id}:\n` +
        `  Type: ${transaction.type}\n` +
        `  Status: ${transaction.status}\n` +
        formatLegDetails("Source Amount", transaction.source, "-") +
        formatLegDetails("Destination Amount", transaction.destination, "+") +
        (transaction.order_id ? `  Order ID: ${transaction.order_id}\n` : "") +
        (transaction.crypto_transaction_hash
          ? `  Crypto Transaction Hash: ${transaction.crypto_transaction_hash}\n`
          : "") +
        (transaction.network ? `  Network: ${transaction.network}\n` : "") +
        (transaction.description
          ? `  Description: ${transaction.description}\n`
          : "") +
        `  Created: ${formatDate(transaction.created_date)}\n` +
        (transaction.processed_date !== undefined
          ? `  Processed: ${formatDate(transaction.processed_date)}\n`
          : "");

      return {
        ...textResult(text),
        structuredContent: { transaction },
      };
    },
  );
}
