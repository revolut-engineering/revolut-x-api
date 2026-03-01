/**
 * Trading tools — orders, cancellation, trade history.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, validateSymbol, validateSide, validateDecimal, validateUUID } from "./_helpers.js";

export function registerTradingTools(server: McpServer): void {
  server.registerTool(
    "place_market_order",
    {
      title: "Place Market Order",
      description: 'Place a market order on Revolut X exchange. Provide either base_size or quote_size, not both.',
      inputSchema: {
        symbol: z.string().describe('Trading pair, e.g. "BTC-USD"'),
        side: z.string().describe('"buy" or "sell"'),
        base_size: z.string().optional().describe('Amount in base currency (e.g. "0.1" BTC).'),
        quote_size: z.string().optional().describe('Amount in quote currency (e.g. "1000" USD).'),
      },
      annotations: { title: "Place Market Order", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ symbol, side, base_size, quote_size }) => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } = await import("../shared/auth/credentials.js");

      symbol = symbol.trim().toUpperCase();
      side = side.trim().toLowerCase();

      let error = validateSymbol(symbol);
      if (error) return textResult(error);
      error = validateSide(side);
      if (error) return textResult(error);

      if (base_size && quote_size) {
        return textResult("Please provide either base_size or quote_size, not both.");
      }
      if (!base_size && !quote_size) {
        return textResult("Please provide either base_size or quote_size.");
      }

      if (base_size) {
        error = validateDecimal(base_size, "base_size");
        if (error) return textResult(error);
      }
      if (quote_size) {
        error = validateDecimal(quote_size, "quote_size");
        if (error) return textResult(error);
      }

      const marketConfig: Record<string, string> = {};
      if (base_size) {
        marketConfig.base_size = base_size.trim();
      } else {
        marketConfig.quote_size = quote_size!.trim();
      }

      const clientOrderId = randomUUID();

      let result: unknown;
      try {
        result = await getRevolutXClient().placeOrder(
          clientOrderId,
          symbol,
          side,
          { market: marketConfig },
        );
      } catch (err) {
        if (err instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw err;
      }

      const data = (result as Record<string, unknown>)?.data ?? result;
      const d = data as Record<string, string>;
      return textResult(
        `Market ${side} order placed!\n\n` +
          `Symbol: ${symbol}\n` +
          `Side: ${side}\n` +
          `Size: ${base_size ?? quote_size} ${base_size ? "(base)" : "(quote)"}\n` +
          `Order ID: ${d.venue_order_id ?? "N/A"}\n` +
          `Client Order ID: ${d.client_order_id ?? clientOrderId}\n` +
          `State: ${d.state ?? "unknown"}`,
      );
    },
  );

  server.registerTool(
    "place_limit_order",
    {
      title: "Place Limit Order",
      description: 'Place a limit order on Revolut X exchange. Provide either base_size or quote_size, not both.',
      inputSchema: {
        symbol: z.string().describe('Trading pair, e.g. "BTC-USD"'),
        side: z.string().describe('"buy" or "sell"'),
        price: z.string().describe('Limit price as string (e.g. "90000.50")'),
        base_size: z.string().optional().describe("Amount in base currency."),
        quote_size: z.string().optional().describe("Amount in quote currency."),
        post_only: z.boolean().default(false).describe("If true, order is only placed as a maker order."),
      },
      annotations: { title: "Place Limit Order", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ symbol, side, price, base_size, quote_size, post_only }) => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } = await import("../shared/auth/credentials.js");

      symbol = symbol.trim().toUpperCase();
      side = side.trim().toLowerCase();

      let error = validateSymbol(symbol);
      if (error) return textResult(error);
      error = validateSide(side);
      if (error) return textResult(error);
      error = validateDecimal(price, "price");
      if (error) return textResult(error);

      if (base_size && quote_size) {
        return textResult("Please provide either base_size or quote_size, not both.");
      }
      if (!base_size && !quote_size) {
        return textResult("Please provide either base_size or quote_size.");
      }

      if (base_size) {
        error = validateDecimal(base_size, "base_size");
        if (error) return textResult(error);
      }
      if (quote_size) {
        error = validateDecimal(quote_size, "quote_size");
        if (error) return textResult(error);
      }

      const limitConfig: Record<string, string | string[]> = { price: price.trim() };
      if (base_size) {
        limitConfig.base_size = base_size.trim();
      } else {
        limitConfig.quote_size = quote_size!.trim();
      }
      limitConfig.execution_instructions = post_only ? ["post_only"] : ["allow_taker"];

      const clientOrderId = randomUUID();

      let result: unknown;
      try {
        result = await getRevolutXClient().placeOrder(
          clientOrderId,
          symbol,
          side,
          { limit: limitConfig },
        );
      } catch (err) {
        if (err instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw err;
      }

      const data = (result as Record<string, unknown>)?.data ?? result;
      const d = data as Record<string, string>;
      return textResult(
        `Limit ${side} order placed!\n\n` +
          `Symbol: ${symbol}\n` +
          `Side: ${side}\n` +
          `Price: ${price}\n` +
          `Size: ${base_size ?? quote_size} ${base_size ? "(base)" : "(quote)"}\n` +
          `Post-only: ${post_only}\n` +
          `Order ID: ${d.venue_order_id ?? "N/A"}\n` +
          `Client Order ID: ${d.client_order_id ?? clientOrderId}\n` +
          `State: ${d.state ?? "unknown"}`,
      );
    },
  );

  server.registerTool(
    "get_active_orders",
    {
      title: "Get Active Orders",
      description: "Get all currently active (open) orders on your Revolut X account.",
      annotations: { title: "Get Active Orders", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } = await import("../shared/auth/credentials.js");

      let result: unknown;
      try {
        result = await getRevolutXClient().getActiveOrders();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw error;
      }

      const orders: Record<string, string>[] = Array.isArray(result)
        ? result
        : ((result as Record<string, unknown>)?.data ?? []) as Record<string, string>[];

      if (!orders.length) {
        return textResult("You have no active orders on your Revolut X account right now.");
      }

      const lines = ["Active orders:\n"];
      for (const o of orders) {
        const orderType = o.type ?? "?";
        const priceLine = orderType === "limit" ? `  Price: ${o.price ?? "N/A"}\n` : "";
        lines.push(
          `  Order ID: ${o.id ?? "?"}\n` +
            `  Client Order ID: ${o.client_order_id ?? "?"}\n` +
            `  Symbol: ${o.symbol ?? "?"}\n` +
            `  Side: ${o.side ?? "?"}\n` +
            `  Type: ${orderType}\n` +
            priceLine +
            `  Quantity: ${o.quantity ?? "?"}\n` +
            `  Filled: ${o.filled_quantity ?? "0"}\n` +
            `  Remaining: ${o.leaves_quantity ?? "?"}\n` +
            `  Status: ${o.status ?? "?"}\n` +
            `  Time in force: ${o.time_in_force ?? "?"}\n` +
            `  Created: ${o.created_date ?? "?"}\n`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel Order",
      description: "Cancel an active order by its venue order ID.",
      inputSchema: {
        venue_order_id: z.string().describe("The order ID returned when the order was placed."),
      },
      annotations: { title: "Cancel Order", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ venue_order_id }) => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } = await import("../shared/auth/credentials.js");

      venue_order_id = venue_order_id.trim();
      const error = validateUUID(venue_order_id);
      if (error) return textResult(error);

      try {
        await getRevolutXClient().cancelOrder(venue_order_id);
      } catch (err) {
        if (err instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw err;
      }

      return textResult(`Order ${venue_order_id} has been cancelled.`);
    },
  );

  server.registerTool(
    "get_client_trades",
    {
      title: "Get Trade History",
      description: "Get your personal trade history (fills) for a specific trading pair.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        limit: z.number().min(1).max(100).default(20).describe("Number of trades to return, 1-100 (default 20)"),
      },
      annotations: { title: "Get Trade History", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ symbol, limit }) => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } = await import("../shared/auth/credentials.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      limit = Math.max(1, Math.min(100, limit));

      let result: unknown;
      try {
        result = await getRevolutXClient().getClientTrades(symbol, undefined, undefined, undefined, limit);
      } catch (err) {
        if (err instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw err;
      }

      const raw = result as Record<string, unknown>;
      const trades = (Array.isArray(raw) ? raw : (raw?.data ?? [])) as Record<string, string>[];
      if (!trades.length) return textResult(`No trade history found for ${symbol}.`);

      const lines = [`Your trades for ${symbol}:\n`];
      lines.push(
        `${"Asset".padStart(8)} | ${"Price".padStart(14)} ${"Cur".padStart(4)} | ${"Quantity".padStart(14)} ${"Cur".padStart(4)} | Time`,
      );
      lines.push("-".repeat(65));
      for (const t of trades) {
        lines.push(
          `${(t.aid ?? "?").padStart(8)} | ` +
            `${(t.p ?? "?").padStart(14)} ${(t.pc ?? "").padStart(4)} | ` +
            `${(t.q ?? "?").padStart(14)} ${(t.qc ?? "").padStart(4)} | ` +
            `${t.tdt ?? "?"}`,
        );
      }

      const metadata = (!Array.isArray(raw) ? (raw?.metadata as Record<string, string>) : undefined) ?? {};
      if (metadata.next_cursor) {
        lines.push(`\nMore trades available (cursor: ${metadata.next_cursor})`);
      }

      return textResult(lines.join("\n"));
    },
  );
}
