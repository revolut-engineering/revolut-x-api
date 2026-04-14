import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTIVE_ORDERS_API_LIMIT,
  HISTORICAL_ORDERS_API_LIMIT,
  PAGINATED_DATA_MAX_LIMIT,
  TRADES_API_LIMIT,
  paginateWithDynamicWindows,
} from "api-k9x2a";
import {
  formatDate,
  textResult,
  validateSymbol,
  handleApiError,
  parseDateRange,
} from "../shared/_helpers.js";

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
      description: `Get all currently active (open) orders on your Revolut X account. The maximum amount user can have is ${ACTIVE_ORDERS_API_LIMIT}.`,
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
            `Maximum total number of orders to return. Default is ${ACTIVE_ORDERS_API_LIMIT}. Max is ${ACTIVE_ORDERS_API_LIMIT}.`,
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
            `  Created: ${formatDate(o.created_date)}\n`,
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
        "Get historical (filled, cancelled, rejected) orders on Revolut X. " +
        "Handles all pagination internally — NEVER call this tool multiple times to paginate or split date ranges. " +
        "If only start_date is provided, returns ALL orders from that date until now. " +
        "If neither date is provided, defaults to the last 30 days. " +
        "If the user asks for 'all orders' or 'all historical orders', set start_date to 2024-05-07 to fetch everything. " +
        "The earliest supported start_date is 2024-05-07 — any earlier date is clamped to this. " +
        "IMPORTANT: If totalLimit is omitted, the result may be very large (>10,000 orders). " +
        "Always ask the user to confirm before fetching without a totalLimit, or suggest a reasonable totalLimit. " +
        "ALWAYS tell the user the date range used in your response. " +
        "The symbols parameter accepts multiple trading pairs at once — pass an array to filter by several symbols in one call, or omit it to fetch orders for all pairs.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by trading pairs, e.g. ["BTC-USD", "ETH-USD"]. Omit to get orders for all pairs.',
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
            "Start of UTC date range. Accepts ISO format (e.g. '2024-05-07') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). " +
              "Earliest supported date is 2024-05-07. " +
              "If only start_date is provided, all orders from this date until now are returned. " +
              "If omitted, defaults to 30 days before end_date (or 30 days ago when both dates are omitted).",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of UTC date range. Accepts ISO format (e.g. '2024-06-30') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). " +
              "If omitted, defaults to the current timestamp.",
          ),
        totalLimit: z
          .number()
          .int()
          .positive()
          .max(PAGINATED_DATA_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum total number of orders to return across all paginated batches. Max is ${PAGINATED_DATA_MAX_LIMIT}. ` +
              "WARNING: If omitted, ALL orders in the date range are returned which may be very large (>10,000). " +
              "Always ask the user to confirm or suggest a reasonable limit before omitting this parameter.",
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
      symbols,
      order_states,
      order_types,
      start_date,
      end_date,
      totalLimit,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let normalizedSymbols: string[] | undefined;
      if (symbols?.length) {
        normalizedSymbols = symbols.map((s) => s.trim().toUpperCase());
        for (const sym of normalizedSymbols) {
          const error = validateSymbol(sym);
          if (error) return textResult(error);
        }
      }

      const dates = parseDateRange(start_date, end_date, {
        defaultWindowMs: 30 * 24 * 60 * 60 * 1000,
        minStartDate: new Date("2024-05-07T00:00:00Z").getTime(),
        endDefaultsToNow: true,
      });
      if ("error" in dates) return dates.error;
      const {
        parsedStartDate: resolvedStartDate,
        parsedEndDate: resolvedEndDate,
      } = dates;

      type Order = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getHistoricalOrders"]>
      >["data"][number];

      let displayOrders: Order[];

      try {
        const client = getRevolutXClient();
        displayOrders = await paginateWithDynamicWindows<Order>({
          fetchPage: (startDate, endDate, cursor, apiLimit) =>
            client.getHistoricalOrders({
              symbols: normalizedSymbols,
              orderStates: order_states,
              orderTypes: order_types,
              startDate,
              endDate,
              cursor,
              limit: apiLimit,
            }),
          startDate: resolvedStartDate,
          endDate: resolvedEndDate,
          apiLimit: HISTORICAL_ORDERS_API_LIMIT,
          userLimit: totalLimit,
        });
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      if (!displayOrders.length) {
        return textResult(
          `No historical orders found for ${formatDate(resolvedStartDate)} to ${formatDate(resolvedEndDate)}.`,
        );
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
            `  Created: ${formatDate(o.created_date)}\n`,
        );
      }

      lines.push("");
      lines.push(
        `*** NOTE TO LLM: Complete results for ${formatDate(resolvedStartDate)} to ${formatDate(resolvedEndDate)}. ` +
          "This is the full dataset — do NOT call this tool again to paginate. " +
          "ALWAYS ask the user if they need a wider date range (earliest available: 2024-05-07). ***",
      );

      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_client_trades",
    {
      title: "Get Trade History",
      description:
        "Get your personal trade history (fills) for a specific trading pair. " +
        "Handles all pagination internally — NEVER call this tool multiple times to paginate or split date ranges. " +
        "If only start_date is provided, returns ALL trades from that date until now. " +
        "If neither date is provided, defaults to the last 30 days. " +
        "If the user asks for 'all trades' or 'all trade history', set start_date to 2024-05-07 to fetch everything. " +
        "The earliest supported start_date is 2024-05-07 — any earlier date is clamped to this. " +
        "IMPORTANT: If totalLimit is omitted, the result may be very large (>10,000 trades). " +
        "Always ask the user to confirm before fetching without a totalLimit, or suggest a reasonable totalLimit. " +
        "ALWAYS tell the user the date range used in your response.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        start_date: z
          .string()
          .optional()
          .describe(
            "Start of UTC date range. Accepts ISO format (e.g. '2024-05-07') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). " +
              "Earliest supported date is 2024-05-07. " +
              "If only start_date is provided, all trades from this date until now are returned. " +
              "If omitted, defaults to 30 days before end_date (or 30 days ago when both dates are omitted).",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End of UTC date range. Accepts ISO format (e.g. '2024-06-30') or relative (e.g. '1h', '30m', '7d' for 1 hour/30 minutes/7 days ago). " +
              "If omitted, defaults to the current timestamp.",
          ),
        totalLimit: z
          .number()
          .int()
          .positive()
          .max(PAGINATED_DATA_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum total number of trades to return across all paginated batches. Max is ${PAGINATED_DATA_MAX_LIMIT}. ` +
              "WARNING: If omitted, ALL trades in the date range are returned which may be very large (>10,000). " +
              "Always ask the user to confirm or suggest a reasonable limit before omitting this parameter.",
          ),
      },
      annotations: {
        title: "Get Trade History",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, start_date, end_date, totalLimit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      const dates = parseDateRange(start_date, end_date, {
        defaultWindowMs: 30 * 24 * 60 * 60 * 1000,
        minStartDate: new Date("2024-05-07T00:00:00Z").getTime(),
        endDefaultsToNow: true,
      });
      if ("error" in dates) return dates.error;
      const {
        parsedStartDate: resolvedStartDate,
        parsedEndDate: resolvedEndDate,
      } = dates;

      type Trade = Awaited<
        ReturnType<ReturnType<typeof getRevolutXClient>["getPrivateTrades"]>
      >["data"][number];

      let displayTrades: Trade[];

      try {
        const client = getRevolutXClient();
        displayTrades = await paginateWithDynamicWindows<Trade>({
          fetchPage: (startDate, endDate, cursor, apiLimit) =>
            client.getPrivateTrades(symbol, {
              startDate,
              endDate,
              cursor,
              limit: apiLimit,
            }),
          startDate: resolvedStartDate,
          endDate: resolvedEndDate,
          apiLimit: TRADES_API_LIMIT,
          userLimit: totalLimit,
        });
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      if (!displayTrades.length)
        return textResult(
          `No trade history found for ${symbol} from ${formatDate(resolvedStartDate)} to ${formatDate(resolvedEndDate)}.`,
        );

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
            `${formatDate(t.timestamp)}`,
        );
      }

      lines.push("");
      lines.push(
        `*** NOTE TO LLM: Complete results for ${formatDate(resolvedStartDate)} to ${formatDate(resolvedEndDate)}. ` +
          "This is the full dataset — do NOT call this tool again to paginate. " +
          "ALWAYS ask the user if they need a wider date range (earliest available: 2024-05-07). ***",
      );

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
            `${formatDate(t.timestamp)}`,
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
          `  Created: ${formatDate(o.created_date)}\n` +
          `  Updated: ${formatDate(o.updated_date)}\n`,
      );
    },
  );
}
