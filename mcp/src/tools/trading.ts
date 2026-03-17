import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {ORDERS_MAX_API_LIMIT, TRADES_MAX_API_LIMIT} from "../constants.js";
import {
  textResult,
  validateSymbol,
  validateSide,
  validateDecimal,
  validateUUID,
  CLI_INSTALL_HINT,
  handleApiError
} from "./_helpers.js";

const VALID_ORDER_ACTIONS = [
  "place_market",
  "place_limit",
  "cancel",
  "cancel_all",
] as const;

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
    "order_command",
    {
      title: "Order CLI Command",
      description:
        "Generate a revx CLI command for order operations. Supports: place_market, place_limit, cancel, cancel_all. " +
        "Returns the exact CLI command to run.",
      inputSchema: {
        action: z
          .enum(VALID_ORDER_ACTIONS)
          .describe(
            "The order operation: place_market, place_limit, cancel, cancel_all.",
          ),
        symbol: z
          .string()
          .optional()
          .describe(
            'Trading pair, e.g. "BTC-USD" (required for place_market, place_limit).',
          ),
        side: z
          .string()
          .optional()
          .describe(
            '"buy" or "sell" (required for place_market, place_limit).',
          ),
        size: z
          .string()
          .optional()
          .describe(
            "Order size in base currency (required unless quote_size is provided).",
          ),
        quote_size: z
          .string()
          .optional()
          .describe("Order size in quote currency (alternative to size)."),
        price: z
          .string()
          .optional()
          .describe("Limit price (required for place_limit)."),
        post_only: z
          .boolean()
          .optional()
          .describe("Post-only execution (place_limit only)."),
        venue_order_id: z
          .string()
          .optional()
          .describe("Order ID to cancel (required for cancel)."),
      },
      annotations: {
        title: "Order CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      action,
      symbol,
      side,
      size,
      quote_size,
      price,
      post_only,
      venue_order_id,
    }) => {
      const act = action;

      switch (act) {
        case "place_market": {
          if (!symbol) return textResult("Missing required parameter: symbol.");
          if (!side) return textResult("Missing required parameter: side.");

          symbol = symbol.trim().toUpperCase();
          side = side.trim().toLowerCase();

          let error = validateSymbol(symbol);
          if (error) return textResult(error);
          error = validateSide(side);
          if (error) return textResult(error);

          if (size && quote_size)
            return textResult(
              "Please provide either size or quote_size, not both.",
            );
          if (!size && !quote_size)
            return textResult("Please provide either size or quote_size.");

          if (size) {
            error = validateDecimal(size, "size");
            if (error) return textResult(error);
          }
          if (quote_size) {
            error = validateDecimal(quote_size, "quote_size");
            if (error) return textResult(error);
          }

          const parts = [
            "revx order place",
            symbol,
            side,
            size ?? "0",
            "--market",
          ];
          if (quote_size) parts.push("--quote-size", quote_size.trim());

          return textResult(
            `Action: Place a market ${side} order\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `Run this command in your terminal to execute the order.` +
              CLI_INSTALL_HINT,
          );
        }

        case "place_limit": {
          if (!symbol) return textResult("Missing required parameter: symbol.");
          if (!side) return textResult("Missing required parameter: side.");
          if (!price) return textResult("Missing required parameter: price.");

          symbol = symbol.trim().toUpperCase();
          side = side.trim().toLowerCase();

          let error = validateSymbol(symbol);
          if (error) return textResult(error);
          error = validateSide(side);
          if (error) return textResult(error);
          error = validateDecimal(price, "price");
          if (error) return textResult(error);

          if (size && quote_size)
            return textResult(
              "Please provide either size or quote_size, not both.",
            );
          if (!size && !quote_size)
            return textResult("Please provide either size or quote_size.");

          if (size) {
            error = validateDecimal(size, "size");
            if (error) return textResult(error);
          }
          if (quote_size) {
            error = validateDecimal(quote_size, "quote_size");
            if (error) return textResult(error);
          }

          const parts = [
            "revx order place",
            symbol,
            side,
            size ?? "0",
            "--limit",
            price.trim(),
          ];
          if (quote_size) parts.push("--quote-size", quote_size.trim());
          if (post_only) parts.push("--post-only");

          return textResult(
            `Action: Place a limit ${side} order\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `Run this command in your terminal to execute the order.` +
              CLI_INSTALL_HINT,
          );
        }

        case "cancel": {
          if (!venue_order_id)
            return textResult("Missing required parameter: venue_order_id.");

          venue_order_id = venue_order_id.trim();
          const error = validateUUID(venue_order_id);
          if (error) return textResult(error);

          return textResult(
            `Action: Cancel order ${venue_order_id}\n\n` +
              `Command:\n  revx order cancel ${venue_order_id}\n\n` +
              `Run this command in your terminal to cancel the order.` +
              CLI_INSTALL_HINT,
          );
        }

        case "cancel_all": {
          return textResult(
            `Action: Cancel all open orders\n\n` +
              `Command:\n  revx order cancel-all\n\n` +
              `Run this command in your terminal to cancel all open orders.` +
              CLI_INSTALL_HINT,
          );
        }
      }
    },
  );

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
              .max(ORDERS_MAX_API_LIMIT)
              .default(100)
              .describe(`Maximum total number of orders to return. Default is 100. Max is ${ORDERS_MAX_API_LIMIT}.`),
        },
        annotations: {
          title: "Get Active Orders",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async ({symbols, side, order_states, order_types, limit }) => {
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
            "Makes a single query up to the requested limit. Pass the returned cursor to fetch the next page.",
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
              .number()
              .optional()
              .describe("Start of date range as epoch milliseconds."),
          end_date: z
              .number()
              .optional()
              .describe("End of date range as epoch milliseconds."),
          cursor: z
              .string()
              .optional()
              .describe(
                  "Pagination cursor from a previous response. Used to resume fetching.",
              ),
          limit: z
              .number()
              .min(1)
              .max(ORDERS_MAX_API_LIMIT)
              .default(100)
              .describe(`Maximum number of orders to return. Default is 100. Max is ${ORDERS_MAX_API_LIMIT}.`),
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
               cursor,
               limit,
             }) => {
        const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

        if (symbol) {
          symbol = symbol.trim().toUpperCase();
          const error = validateSymbol(symbol);
          if (error) return textResult(error);
        }

        const baseOpts = {
          symbols: symbol ? [symbol] : undefined,
          orderStates: order_states,
          orderTypes: order_types,
          limit: limit,
          startDate: start_date,
          endDate: end_date,
          cursor: cursor,
        };

        type Order = Awaited<
            ReturnType<ReturnType<typeof getRevolutXClient>["getHistoricalOrders"]>
        >["data"][number];

        let allOrders: Order[] = [];
        let nextCursor: string | undefined = undefined;

        try {
          const result = await getRevolutXClient().getHistoricalOrders(baseOpts);

          allOrders = result.data;
          nextCursor = result.metadata?.next_cursor;
        } catch (error) {
          const handled = await handleApiError(error, SETUP_GUIDE);
          if (handled) return handled;
          throw error;
        }

        if (!allOrders || !allOrders.length) {
          return textResult("No historical orders found.");
        }

        const lines = [`Historical orders (${allOrders.length} returned):\n`];
        for (const o of allOrders) {
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

        if (nextCursor) {
          lines.push(`\nMore orders are available. To fetch the next page, use cursor: ${nextCursor}`);
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
            "Makes a single query up to the requested limit. Pass the returned cursor to fetch the next page.",
        inputSchema: {
          symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
          start_date: z
              .number()
              .optional()
              .describe("Start of date range as epoch milliseconds."),
          end_date: z
              .number()
              .optional()
              .describe("End of date range as epoch milliseconds."),
          cursor: z
              .string()
              .optional()
              .describe(
                  "Pagination cursor from a previous response. Used to resume fetching.",
              ),
          limit: z
              .number()
              .min(1)
              .max(TRADES_MAX_API_LIMIT)
              .default(100)
              .describe(`Maximum number of trades to return. Default is 100. Max is ${TRADES_MAX_API_LIMIT}.`),
        },
        annotations: {
          title: "Get Trade History",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async ({ symbol, start_date, end_date, cursor, limit }) => {
        const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

        symbol = symbol.trim().toUpperCase();
        const error = validateSymbol(symbol);
        if (error) return textResult(error);

        type Trade = Awaited<
            ReturnType<ReturnType<typeof getRevolutXClient>["getPrivateTrades"]>
        >["data"][number];

        let allTrades: Trade[] = [];
        let nextCursor: string | undefined = undefined;

        try {
          const result = await getRevolutXClient().getPrivateTrades(symbol, {
            startDate: start_date,
            endDate: end_date,
            cursor: cursor,
            limit: limit,
          });

          allTrades = result.data;
          nextCursor = result.metadata?.next_cursor;
        } catch (err) {
          const handled = await handleApiError(err, SETUP_GUIDE);
          if (handled) return handled;
          throw err;
        }

        if (!allTrades || !allTrades.length)
          return textResult(`No trade history found for ${symbol}.`);

        const lines = [
          `Your trades for ${symbol} (${allTrades.length} returned):\n`,
        ];
        lines.push(
            `${"ID".padEnd(36)} | ${"Order ID".padEnd(36)} | ${"Symbol".padStart(10)} | ${"Side".padStart(4)} | ${"Price".padStart(14)} | ${"Quantity".padStart(14)} | ${"Maker".padStart(5)} | Time`,
        );
        lines.push("-".repeat(145));
        for (const t of allTrades) {
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

        if (nextCursor) {
          lines.push(`\nMore trades are available. To fetch the next page, use cursor: ${nextCursor}`);
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
      const execLine =
        o.execution_instructions.length
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
