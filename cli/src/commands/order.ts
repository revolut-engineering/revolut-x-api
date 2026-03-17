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

function pushTriggerRows(
  rows: [string, string][],
  label: string,
  t: Order["conditional"],
): void {
  if (!t) return;
  const dir = t.trigger_direction === "ge" ? ">=" : "<=";
  rows.push([`--- ${label} ---`, ""]);
  rows.push([
    "  Trigger Price",
    `${t.trigger_price} (when price ${dir} ${t.trigger_price})`,
  ]);
  rows.push(["  Order Type", t.type]);
  rows.push(["  Time in Force", t.time_in_force]);
  if (t.limit_price) rows.push(["  Limit Price", t.limit_price]);
  if (t.execution_instructions.length)
    rows.push(["  Execution", t.execution_instructions.join(", ")]);
}

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
    .option(
      "--symbols <pairs>",
      "Filter by pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option(
      "--order-states <states>",
      "Filter by states (comma-separated: pending_new,new,partially_filled)",
    )
    .option(
      "--order-types <types>",
      "Filter by types (comma-separated: limit,conditional,tpsl)",
    )
    .option("--side <side>", "Filter by side (buy|sell)")
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        symbols?: string;
        orderStates?: string;
        orderTypes?: string;
        side?: string;
        limit?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const queryOpts: Parameters<typeof client.getActiveOrders>[0] = {};
          if (opts.symbols) queryOpts.symbols = opts.symbols.split(",");
          if (opts.orderStates)
            queryOpts.orderStates = opts.orderStates.split(",") as NonNullable<
              Parameters<typeof client.getActiveOrders>[0]
            >["orderStates"];
          if (opts.orderTypes)
            queryOpts.orderTypes = opts.orderTypes.split(",") as NonNullable<
              Parameters<typeof client.getActiveOrders>[0]
            >["orderTypes"];
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
    .option(
      "--symbols <pairs>",
      "Filter by pairs (comma-separated, e.g. BTC-USD,ETH-USD)",
    )
    .option(
      "--order-states <states>",
      "Filter by states (comma-separated: filled,cancelled,rejected,replaced)",
    )
    .option(
      "--order-types <types>",
      "Filter by types (comma-separated: market,limit)",
    )
    .option(
      "--start-date <date>",
      "Start date (ISO, epoch ms, or relative: 7d, 1w, today)",
    )
    .option(
      "--end-date <date>",
      "End date (ISO, epoch ms, or relative: today, yesterday)",
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        symbols?: string;
        orderStates?: string;
        orderTypes?: string;
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
          if (opts.symbols) queryOpts.symbols = opts.symbols.split(",");
          if (opts.orderStates)
            queryOpts.orderStates = opts.orderStates.split(",") as NonNullable<
              Parameters<typeof client.getHistoricalOrders>[0]
            >["orderStates"];
          if (opts.orderTypes)
            queryOpts.orderTypes = opts.orderTypes.split(",") as NonNullable<
              Parameters<typeof client.getHistoricalOrders>[0]
            >["orderTypes"];
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
            const rows: [string, string][] = [
              ["ID", o.id],
              ["Client Order ID", o.client_order_id],
              ["Symbol", o.symbol],
              ["Side", o.side],
              ["Type", o.type],
              ["Quantity", o.quantity],
              ["Filled", o.filled_quantity],
              ["Remaining", o.leaves_quantity],
              ["Price", o.price ?? "—"],
              ...(o.average_fill_price
                ? [["Avg Fill Price", o.average_fill_price] as [string, string]]
                : []),
              ["Status", o.status],
              ...(o.reject_reason
                ? [["Reject Reason", o.reject_reason] as [string, string]]
                : []),
              ["Time in Force", o.time_in_force],
              ...(o.execution_instructions.length
                ? [
                    ["Execution", o.execution_instructions.join(", ")] as [
                      string,
                      string,
                    ],
                  ]
                : []),
              ["Created", new Date(o.created_date).toISOString()],
              ["Updated", new Date(o.updated_date).toISOString()],
              ...(o.previous_order_id
                ? [
                    ["Previous Order ID", o.previous_order_id] as [
                      string,
                      string,
                    ],
                  ]
                : []),
            ];

            pushTriggerRows(rows, "Trigger", o.conditional);
            pushTriggerRows(rows, "Take Profit", o.take_profit);
            pushTriggerRows(rows, "Stop Loss", o.stop_loss);

            printKeyValue(rows);
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
