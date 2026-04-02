import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTIVE_ORDERS_API_LIMIT,
  HISTORICAL_ORDERS_API_LIMIT,
  TRADES_API_LIMIT,
} from "../constants.js";
import { textResult, validateSymbol, handleApiError } from "./_helpers.js";

function formatTrigger(
  label: string,
  t: {
    trigger_price: string;
    type: string;
    trigger_direction: string;
    limit_price?: string;
    time_in_force: string;
    execution_instructions: string[];
  },
): string {
  const direction = t.trigger_direction === "ge" ? ">=" : "<=";
  let line =
    `  ${label}:\n` +
    `    Trigger price: ${t.trigger_price} (when price ${direction} ${t.trigger_price})\n` +
    `    Order type: ${t.type}\n` +
    `    Time in force: ${t.time_in_force}\n`;
  if (t.limit_price) line += `    Limit price: ${t.limit_price}\n`;
  if (t.execution_instructions.length)
    line += `    Execution instructions: ${t.execution_instructions.join(", ")}\n`;
  return line;
}

export function registerTradingTools(server: McpServer): void {
  server.registerTool(
    "get_active_orders",
    {
      title: "Get Active Orders",
      description:
        "Get all currently active (open) orders on your Revolut X account.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .optional()
          .describe('Filter by trading pairs, e.g. ["BTC-USD", "ETH-USD"].'),
        side: z
          .enum(["buy", "sell"])
          .optional()
          .describe('Filter by side: "buy" or "sell".'),
        order_states: z
          .array(z.enum(["pending_new", "new", "partially_filled"]))
          .optional()
          .describe(
            'Filter by order state: "pending_new", "new", "partially_filled".',
          ),
        order_types: z
          .array(z.enum(["limit", "conditional", "tpsl"]))
          .optional()
          .describe('Filter by order type: "limit", "conditional", "tpsl".'),
        limit: z
          .number()
          .min(1)
          .max(ACTIVE_ORDERS_API_LIMIT)
          .default(ACTIVE_ORDERS_API_LIMIT)
          .describe(
            `Maximum total number of orders to return. Default is 100. Max is ${HISTORICAL_ORDERS_API_LIMIT}.`,
          ),
      },
      annotations: {
        title: "Get Active Orders",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbols, side, order_states, order_types, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      type Order = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getActiveOrders"]>
      >["data"][number];

      let orders: Order[] = [];

      try {
        const result = await getRevolutXClient().getActiveOrders({
          symbols,
          side,
          orderStates: order_states,
          orderTypes: order_types,
          limit: limit,
        });

        orders = result.data;
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      if (!orders || !orders.length) {
        return textResult(
          "You have no active orders on your Revolut X account right now.",
        );
      }

      const lines = ["Active orders:\n"];
      for (const o of orders) {
        const priceLine = o.type === "limit" ? `  Price: ${o.price}\n` : "";
        const execLine =
          o.execution_instructions && o.execution_instructions.length
            ? `  Execution instructions: ${o.execution_instructions.join(", ")}\n`
            : "";
        const conditionalLine = o.conditional
          ? formatTrigger("Conditional trigger", o.conditional)
          : "";
        const takeProfitLine = o.take_profit
          ? formatTrigger("Take profit", o.take_profit)
          : "";
        const stopLossLine = o.stop_loss
          ? formatTrigger("Stop loss", o.stop_loss)
          : "";
        lines.push(
          `  Order ID: ${o.id}\n` +
            `  Client Order ID: ${o.client_order_id}\n` +
            `  Symbol: ${o.symbol}\n` +
            `  Side: ${o.side}\n` +
            `  Type: ${o.type}\n` +
            priceLine +
            execLine +
            conditionalLine +
            takeProfitLine +
            stopLossLine +
            `  Quantity: ${o.quantity}\n` +
            `  Filled: ${o.filled_quantity}\n` +
            `  Remaining: ${o.leaves_quantity}\n` +
            `  Status: ${o.status}\n` +
            `  Time in force: ${o.time_in_force}\n` +
            `  Created: ${o.created_date}\n`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_historical_orders",
    {
      title: "Get Historical Orders",
      description:
        "Get your historical (filled, cancelled, rejected) orders on Revolut X. " +
        "Always returns 1 complete batch for the given time range. Do not attempt to paginate.",
      inputSchema: {
        symbol: z
          .string()
          .optional()
          .describe(
            'Filter by trading pair, e.g. "BTC-USD". Omit to get orders for all pairs.',
          ),
        order_states: z
          .array(z.enum(["filled", "cancelled", "rejected", "replaced"]))
          .optional()
          .describe(
            'Filter by order state: "filled", "cancelled", "rejected", "replaced".',
          ),
        order_types: z
          .array(z.enum(["market", "limit"]))
          .optional()
          .describe('Filter by order type: "market", "limit".'),
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of date range in standard ISO format (e.g., '2023-01-01' or '2023-01-01T12:00:00Z').",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of date range in standard ISO format (e.g., '2023-12-31' or '2023-12-31T23:59:59Z').",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum total number of orders to return across all pages. Omit to fetch all orders in the date range.",
          ),
      },
      annotations: {
        title: "Get Historical Orders",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      symbol,
      order_states,
      order_types,
      start_date,
      end_date,
      limit,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      if (symbol) {
        symbol = symbol.trim().toUpperCase();
        const error = validateSymbol(symbol);
        if (error) return textResult(error);
      }

      let parsedStartDate = undefined;
      if (start_date) {
        const d = new Date(start_date);
        if (isNaN(d.getTime())) {
          return textResult(
            "Error: Invalid start_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
          );
        }
        parsedStartDate = d.getTime();
      }

      let parsedEndDate = undefined;
      if (end_date) {
        const d = new Date(end_date);
        if (isNaN(d.getTime())) {
          return textResult(
            "Error: Invalid end_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
          );
        }
        parsedEndDate = d.getTime();
      }

      type Order = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getHistoricalOrders"]>
      >["data"][number];

      const allOrders: Order[] = [];

      try {
        const endTimeMs = parsedEndDate || Date.now();
        let currentStart =
          parsedStartDate || endTimeMs - 30 * 24 * 60 * 60 * 1000;
        while (currentStart < endTimeMs) {
          const currentEndObj = new Date(currentStart);
          currentEndObj.setMonth(currentEndObj.getMonth() + 1);
          let currentEndMs = currentEndObj.getTime();
          if (currentEndMs > endTimeMs) currentEndMs = endTimeMs;

          let currentCursor: string | undefined = undefined;
          let hasMoreInMonth = true;

          while (hasMoreInMonth) {
            const result = await getRevolutXClient().getHistoricalOrders({
              symbols: symbol ? [symbol] : undefined,
              orderStates: order_states,
              orderTypes: order_types,
              startDate: currentStart,
              endDate: currentEndMs,
              cursor: currentCursor,
              limit: HISTORICAL_ORDERS_API_LIMIT,
            });

            if (result.data && result.data.length > 0) {
              if (limit !== undefined) {
                const remaining = limit - allOrders.length;
                allOrders.push(...result.data.slice(0, remaining));
              } else {
                allOrders.push(...result.data);
              }
            }

            if (limit !== undefined && allOrders.length >= limit) break;

            currentCursor = result.metadata?.next_cursor;
            if (!currentCursor) hasMoreInMonth = false;
          }

          if (limit !== undefined && allOrders.length >= limit) break;
          currentStart = currentEndMs;
        }
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const displayOrders =
        limit !== undefined ? allOrders.slice(0, limit) : allOrders;

      if (!displayOrders.length) {
        return textResult("No historical orders found.");
      }

      const lines = [`Historical orders (${displayOrders.length} returned):\n`];
      for (const o of displayOrders) {
        const priceLine = o.price ? `  Price: ${o.price}\n` : "";
        const avgFillLine = o.average_fill_price
          ? `  Avg Fill Price: ${o.average_fill_price}\n`
          : "";
        lines.push(
          `  Order ID: ${o.id}\n` +
            `  Client Order ID: ${o.client_order_id}\n` +
            `  Symbol: ${o.symbol}\n` +
            `  Side: ${o.side}\n` +
            `  Type: ${o.type}\n` +
            priceLine +
            avgFillLine +
            `  Quantity: ${o.quantity}\n` +
            `  Filled: ${o.filled_quantity}\n` +
            `  Remaining: ${o.leaves_quantity}\n` +
            `  Status: ${o.status}\n` +
            `  Time in force: ${o.time_in_force}\n` +
            `  Created: ${o.created_date}\n`,
        );
      }

      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_client_trades",
    {
      title: "Get Trade History",
      description:
        "Get your personal trade history (fills) for a specific trading pair. " +
        "Always returns 1 complete batch for the given time range. Do not attempt to paginate.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of date range in standard ISO format (e.g., '2023-01-01' or '2023-01-01T12:00:00Z').",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of date range in standard ISO format (e.g., '2023-12-31' or '2023-12-31T23:59:59Z').",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum total number of trades to return across all pages. Omit to fetch all trades in the date range.",
          ),
      },
      annotations: {
        title: "Get Trade History",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, start_date, end_date, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      let parsedStartDate = undefined;
      if (start_date) {
        const d = new Date(start_date);
        if (isNaN(d.getTime())) {
          return textResult(
            "Error: Invalid start_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
          );
        }
        parsedStartDate = d.getTime();
      }

      let parsedEndDate = undefined;
      if (end_date) {
        const d = new Date(end_date);
        if (isNaN(d.getTime())) {
          return textResult(
            "Error: Invalid end_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
          );
        }
        parsedEndDate = d.getTime();
      }

      type Trade = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getPrivateTrades"]>
      >["data"][number];

      const allTrades: Trade[] = [];

      try {
        const endTimeMs = parsedEndDate || Date.now();
        let currentStart =
          parsedStartDate || endTimeMs - 30 * 24 * 60 * 60 * 1000;
        while (currentStart < endTimeMs) {
          const currentEndObj = new Date(currentStart);
          currentEndObj.setMonth(currentEndObj.getMonth() + 1);
          let currentEndMs = currentEndObj.getTime();
          if (currentEndMs > endTimeMs) currentEndMs = endTimeMs;

          let currentCursor: string | undefined = undefined;
          let hasMoreInMonth = true;

          while (hasMoreInMonth) {
            const result = await getRevolutXClient().getPrivateTrades(symbol, {
              startDate: currentStart,
              endDate: currentEndMs,
              cursor: currentCursor,
              limit: TRADES_API_LIMIT,
            });

            if (result.data && result.data.length > 0) {
              if (limit !== undefined) {
                const remaining = limit - allTrades.length;
                allTrades.push(...result.data.slice(0, remaining));
              } else {
                allTrades.push(...result.data);
              }
            }

            if (limit !== undefined && allTrades.length >= limit) break;

            currentCursor = result.metadata?.next_cursor;
            if (!currentCursor) hasMoreInMonth = false;
          }

          if (limit !== undefined && allTrades.length >= limit) break;
          currentStart = currentEndMs;
        }
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      const displayTrades =
        limit !== undefined ? allTrades.slice(0, limit) : allTrades;

      if (!displayTrades.length)
        return textResult(`No trade history found for ${symbol}.`);

      const lines = [
        `Your trades for ${symbol} (${displayTrades.length} returned):\n`,
      ];
      lines.push(
        `${"ID".padEnd(36)} | ${"Order ID".padEnd(36)} | ${"Symbol".padStart(10)} | ${"Side".padStart(4)} | ${"Price".padStart(14)} | ${"Quantity".padStart(14)} | ${"Maker".padStart(5)} | Time`,
      );
      lines.push("-".repeat(145));
      for (const t of displayTrades) {
        lines.push(
          `${t.id.padEnd(36)} | ` +
            `${t.orderId.padEnd(36)} | ` +
            `${t.symbol.padStart(10)} | ` +
            `${t.side.padStart(4)} | ` +
            `${t.price.padStart(14)} | ` +
            `${t.quantity.padStart(14)} | ` +
            `${String(t.maker).padStart(5)} | ` +
            `${new Date(t.timestamp).toISOString()}`,
        );
      }

      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_order_fills",
    {
      title: "Get Order Fills",
      description:
        "Get all fills (trade executions) for a specific order by its order ID.",
      inputSchema: {
        order_id: z.string().describe("The order ID to retrieve fills for."),
      },
      annotations: {
        title: "Get Order Fills",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ order_id }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let result;
      try {
        result = await getRevolutXClient().getOrderFills(order_id);
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      const fills = result.data;

      if (!fills.length)
        return textResult(`No fills found for order ${order_id}.`);

      const lines = [`Fills for order ${order_id} (${fills.length} total):\n`];
      lines.push(
        `${"ID".padEnd(36)} | ${"Symbol".padStart(10)} | ${"Side".padStart(4)} | ${"Price".padStart(14)} | ${"Quantity".padStart(14)} | ${"Maker".padStart(5)} | Time`,
      );
      lines.push("-".repeat(110));
      for (const t of fills) {
        lines.push(
          `${t.id.padEnd(36)} | ` +
            `${t.symbol.padStart(10)} | ` +
            `${t.side.padStart(4)} | ` +
            `${t.price.padStart(14)} | ` +
            `${t.quantity.padStart(14)} | ` +
            `${String(t.maker).padStart(5)} | ` +
            `${new Date(t.timestamp).toISOString()}`,
        );
      }

      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_order_by_id",
    {
      title: "Get Order by ID",
      description:
        "Get the full details of a single order by its venue order ID. " +
        "Supports market, limit, conditional, and tpsl orders.",
      inputSchema: {
        order_id: z.string().describe("The venue order ID to look up."),
      },
      annotations: {
        title: "Get Order by ID",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ order_id }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let result;
      try {
        result = await getRevolutXClient().getOrder(order_id);
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      const o = result.data;

      const priceLine = o.type === "limit" ? `  Price: ${o.price}\n` : "";
      const execLine = o.execution_instructions.length
        ? `  Execution instructions: ${o.execution_instructions.join(", ")}\n`
        : "";
      const conditionalLine = o.conditional
        ? formatTrigger("Conditional trigger", o.conditional)
        : "";
      const takeProfitLine = o.take_profit
        ? formatTrigger("Take profit", o.take_profit)
        : "";
      const stopLossLine = o.stop_loss
        ? formatTrigger("Stop loss", o.stop_loss)
        : "";
      const avgFillLine = o.average_fill_price
        ? `  Avg fill price: ${o.average_fill_price}\n`
        : "";
      const rejectLine = o.reject_reason
        ? `  Reject reason: ${o.reject_reason}\n`
        : "";
      const prevOrderLine = o.previous_order_id
        ? `  Previous order ID: ${o.previous_order_id}\n`
        : "";

      return textResult(
        `Order ${o.id}:\n\n` +
          `  Client Order ID: ${o.client_order_id}\n` +
          prevOrderLine +
          `  Symbol: ${o.symbol}\n` +
          `  Side: ${o.side}\n` +
          `  Type: ${o.type}\n` +
          priceLine +
          execLine +
          conditionalLine +
          takeProfitLine +
          stopLossLine +
          `  Quantity: ${o.quantity}\n` +
          `  Filled: ${o.filled_quantity}\n` +
          `  Remaining: ${o.leaves_quantity}\n` +
          avgFillLine +
          `  Status: ${o.status}\n` +
          rejectLine +
          `  Time in force: ${o.time_in_force}\n` +
          `  Created: ${o.created_date}\n` +
          `  Updated: ${o.updated_date}\n`,
      );
    },
  );
}
