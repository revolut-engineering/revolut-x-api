import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PAGINATED_DATA_MAX_LIMIT,
  TRANSACTIONS_API_LIMIT,
  paginateWithDynamicWindows,
  type Transaction,
} from "@revolut/revolut-x-api";
import {
  formatDate,
  handleApiError,
  parseDateRange,
  textResult,
} from "../shared/_helpers.js";

function formatFlow(
  amount: string | undefined,
  currency: string | undefined,
  sign: "+" | "-",
): string | undefined {
  if (!amount || !currency) return undefined;
  const unsignedAmount = amount.replace(/^[+-]/, "");
  return `${sign}${unsignedAmount} ${currency}`;
}

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    "get_transactions",
    {
      title: "Get Transactions",
      description:
        "Get your transaction history, including buys, sells, sends, and receives. " +
        "Each transaction may contain a source amount, a destination amount, or both. " +
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
          .array(z.enum(["buy", "sell", "send", "receive"]))
          .optional()
          .describe("Filter by transaction type: buy, sell, send, or receive."),
        statuses: z
          .array(
            z.enum(["pending", "completed", "rejected", "failed", "cancelled"]),
          )
          .optional()
          .describe(
            "Filter by transaction status: pending, completed, rejected, failed, or cancelled.",
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
              "rejected",
              "failed",
              "cancelled",
            ]),
            type: z.enum(["buy", "sell", "send", "receive"]),
            source_currency: z.string().optional(),
            source_amount: z.string().optional(),
            destination_currency: z.string().optional(),
            destination_amount: z.string().optional(),
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
          transaction.source_amount,
          transaction.source_currency,
          "-",
        );
        const destinationAmount = formatFlow(
          transaction.destination_amount,
          transaction.destination_currency,
          "+",
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
}
