import { Command } from "commander";
import type { Order } from "revolutx-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  printSuccess,
  type ColumnDef,
} from "../output/formatter.js";

const ORDER_COLUMNS: ColumnDef<Order>[] = [
  { header: "ID", key: "id" },
  { header: "Symbol", key: "symbol" },
  { header: "Side", key: "side" },
  { header: "Type", key: "type" },
  { header: "Qty", key: "quantity", align: "right" },
  { header: "Filled", key: "filled_quantity", align: "right" },
  { header: "Price", key: "price", align: "right" },
  { header: "Status", key: "status" },
];

export function registerOrderCommand(program: Command): void {
  const order = program
    .command("order")
    .description("Order management")
    .addHelpText(
      "after",
      `
Examples:
  $ revx order place BTC-USD buy 0.001 --market       Place market buy
  $ revx order place BTC-USD sell 0.001 --limit 95000  Place limit sell
  $ revx order list                                    List active orders
  $ revx order history --symbol BTC-USD                Order history for pair
  $ revx order get <order-id>                          Get order details
  $ revx order cancel <order-id>                       Cancel an order
  $ revx order cancel-all                              Cancel all open orders
  $ revx order fills <order-id>                        Get order fills`,
    );

  order
    .command("place <symbol> <side> <size>")
    .description(
      "Place an order (e.g. revx order place BTC-USD buy 0.001 --limit 95000)",
    )
    .option("--limit <price>", "Limit order price (required unless --market)")
    .option("--market", "Market order (required unless --limit)")
    .option(
      "--quote-size <amount>",
      "Size in quote currency (alternative to <size>)",
    )
    .option("--post-only", "Post-only execution instruction")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        side: string,
        size: string,
        opts: {
          limit?: string;
          market?: boolean;
          quoteSize?: string;
          postOnly?: boolean;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });

          if (!["buy", "sell"].includes(side.toLowerCase())) {
            console.error("Side must be 'buy' or 'sell'.");
            process.exit(1);
          }

          const params: Parameters<typeof client.placeOrder>[0] = {
            symbol,
            side: side.toLowerCase() as "buy" | "sell",
          };

          if (opts.market) {
            params.market = opts.quoteSize
              ? { quoteSize: opts.quoteSize }
              : { baseSize: size };
          } else if (opts.limit) {
            params.limit = {
              price: opts.limit,
              ...(opts.quoteSize
                ? { quoteSize: opts.quoteSize }
                : { baseSize: size }),
              ...(opts.postOnly
                ? { executionInstructions: ["post_only"] }
                : {}),
            };
          } else {
            console.error("Specify --limit <price> or --market.");
            process.exit(1);
          }

          const result = await client.placeOrder(params);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSuccess(`Order placed successfully.`);
            printKeyValue([
              ["Venue Order ID", result.data.venue_order_id],
              ["Client Order ID", result.data.client_order_id],
              ["State", result.data.state],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("list")
    .description("List active orders")
    .option("--symbol <pair>", "Filter by trading pair")
    .option("--side <side>", "Filter by side (buy|sell)")
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        symbol?: string;
        side?: string;
        limit?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const queryOpts: Parameters<typeof client.getActiveOrders>[0] = {};
          if (opts.symbol) queryOpts.symbols = [opts.symbol];
          if (opts.side) queryOpts.side = opts.side as "buy" | "sell";
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");

          const result = await client.getActiveOrders(queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printTable(result.data, ORDER_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("history")
    .description("List historical orders")
    .option("--symbol <pair>", "Filter by trading pair")
    .option("--start-date <date>", "Start date (ISO or epoch ms)")
    .option("--end-date <date>", "End date (ISO or epoch ms)")
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        symbol?: string;
        startDate?: string;
        endDate?: string;
        limit?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const queryOpts: Parameters<typeof client.getHistoricalOrders>[0] =
            {};
          if (opts.symbol) queryOpts.symbols = [opts.symbol];
          if (opts.startDate)
            queryOpts.startDate = parseTimestamp(opts.startDate);
          if (opts.endDate) queryOpts.endDate = parseTimestamp(opts.endDate);
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");

          const result = await client.getHistoricalOrders(queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printTable(result.data, ORDER_COLUMNS);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("get <order-id>")
    .description("Get details of a specific order")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (orderId: string, opts: { json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const result = await client.getOrder(orderId);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            const o = result.data;
            printKeyValue([
              ["ID", o.id],
              ["Client Order ID", o.client_order_id],
              ["Symbol", o.symbol],
              ["Side", o.side],
              ["Type", o.type],
              ["Quantity", o.quantity],
              ["Filled", o.filled_quantity],
              ["Remaining", o.leaves_quantity],
              ["Price", o.price ?? "—"],
              ["Status", o.status],
              ["Time in Force", o.time_in_force],
              ["Created", new Date(o.created_date).toISOString()],
              ["Updated", new Date(o.updated_date).toISOString()],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("cancel <order-id>")
    .description("Cancel an order")
    .action(async (orderId: string) => {
      try {
        const client = getClient({ requireAuth: true });
        await client.cancelOrder(orderId);
        printSuccess(`Order ${orderId} cancelled.`);
      } catch (err) {
        handleError(err);
      }
    });

  order
    .command("cancel-all")
    .description("Cancel all open orders")
    .action(async () => {
      try {
        const client = getClient({ requireAuth: true });
        await client.cancelAllOrders();
        printSuccess("All open orders cancelled.");
      } catch (err) {
        handleError(err);
      }
    });

  order
    .command("fills <order-id>")
    .description("Get fills for an order")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (orderId: string, opts: { json?: boolean; output?: string }) => {
        try {
          const client = getClient({ requireAuth: true });
          const result = await client.getOrderFills(orderId);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printTable(result.data, [
              { header: "Trade ID", key: "id" },
              { header: "Symbol", key: "symbol" },
              { header: "Side", key: "side" },
              { header: "Price", key: "price", align: "right" },
              { header: "Qty", key: "quantity", align: "right" },
              { header: "Maker", key: "maker" },
              {
                header: "Time",
                accessor: (t) => new Date(t.timestamp).toISOString(),
              },
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
