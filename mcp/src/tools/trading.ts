import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  textResult,
  validateSymbol,
  validateSide,
  validateDecimal,
  validateUUID,
  CLI_INSTALL_HINT,
  handleApiError,
} from "./_helpers.js";

const VALID_ORDER_ACTIONS = ["place_market", "place_limit", "cancel"] as const;

export function registerTradingTools(server: McpServer): void {
  server.registerTool(
    "order_command",
    {
      title: "Order CLI Command",
      description:
        "Generate a revx CLI command for order operations. Supports: place_market, place_limit, cancel. " +
        "Returns the exact CLI command to run.",
      inputSchema: {
        action: z
          .enum(VALID_ORDER_ACTIONS)
          .describe("The order operation: place_market, place_limit, cancel."),
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
      },
      annotations: {
        title: "Get Active Orders",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbols, side, order_states, order_types }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      let result;
      try {
        result = await getRevolutXClient().getActiveOrders({
          symbols,
          side,
          orderStates: order_states,
          orderTypes: order_types,
        });
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const orders = result.data;

      if (!orders.length) {
        return textResult(
          "You have no active orders on your Revolut X account right now.",
        );
      }

      const lines = ["Active orders:\n"];
      for (const o of orders) {
        const priceLine = o.type === "limit" ? `  Price: ${o.price}\n` : "";
        lines.push(
          `  Order ID: ${o.id}\n` +
            `  Client Order ID: ${o.client_order_id}\n` +
            `  Symbol: ${o.symbol}\n` +
            `  Side: ${o.side}\n` +
            `  Type: ${o.type}\n` +
            priceLine +
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
        "Get your historical (completed, cancelled, rejected) orders on Revolut X. " +
        "Optionally filter by trading pair, state, type, and date range.",
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
          .describe("Start date as epoch milliseconds."),
        end_date: z
          .number()
          .optional()
          .describe("End date as epoch milliseconds."),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Number of orders to return, 1-100 (default 20)."),
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

      limit = Math.max(1, Math.min(100, limit));

      let result;
      try {
        result = await getRevolutXClient().getHistoricalOrders({
          symbols: symbol ? [symbol] : undefined,
          orderStates: order_states,
          orderTypes: order_types,
          startDate: start_date,
          endDate: end_date,
          limit,
        });
      } catch (error) {
        const handled = await handleApiError(error, SETUP_GUIDE);
        if (handled) return handled;
        throw error;
      }

      const orders = result.data;

      if (!orders.length) {
        return textResult("No historical orders found.");
      }

      const lines = ["Historical orders:\n"];
      for (const o of orders) {
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

      if (result.metadata.next_cursor) {
        lines.push(
          `\nMore orders available (cursor: ${result.metadata.next_cursor})`,
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
        "Get your personal trade history (fills) for a specific trading pair.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Number of trades to return, 1-100 (default 20)"),
      },
      annotations: {
        title: "Get Trade History",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, limit }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(100, limit));

      let result;
      try {
        result = await getRevolutXClient().getPrivateTrades(symbol, { limit });
      } catch (err) {
        const handled = await handleApiError(err, SETUP_GUIDE);
        if (handled) return handled;
        throw err;
      }

      const trades = result.data;
      if (!trades.length)
        return textResult(`No trade history found for ${symbol}.`);

      const lines = [`Your trades for ${symbol}:\n`];
      lines.push(
        `${"Asset".padStart(8)} | ${"Price".padStart(14)} ${"Cur".padStart(4)} | ${"Quantity".padStart(14)} ${"Cur".padStart(4)} | Time`,
      );
      lines.push("-".repeat(65));
      for (const t of trades) {
        lines.push(
          `${t.aid.padStart(8)} | ` +
            `${t.p.padStart(14)} ${t.pc.padStart(4)} | ` +
            `${t.q.padStart(14)} ${t.qc.padStart(4)} | ` +
            `${t.tdt}`,
        );
      }

      if (result.metadata.next_cursor) {
        lines.push(
          `\nMore trades available (cursor: ${result.metadata.next_cursor})`,
        );
      }

      return textResult(lines.join("\n"));
    },
  );
}
