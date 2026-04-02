import { Command } from "commander";
import chalk from "chalk";
import type { Order } from "api-k9x2a";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import { parseTimestamp, parsePositiveInt } from "../util/parse.js";
import { requireSessionAuth } from "../util/session.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  printSuccess,
  type ColumnDef,
} from "../output/formatter.js";

// --- NEW/MODIFIED: Helper to format the period string ---
function formatPeriod(start?: number, end?: number): string {
  if (start && end) {
    return `Period: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`;
  }
  if (start) {
    return `Period: Since ${new Date(start).toISOString()}`;
  }
  if (end) {
    return `Period: Up to ${new Date(end).toISOString()}`;
  }
  return "Period: Default / Recent";
}

// --- MODIFIED: Added subtitle parameter to display the period ---
function printSectionHeader(title: string, subtitle?: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  if (subtitle) {
    console.log(chalk.gray(`  ${subtitle}`));
  }
  console.log(chalk.dim("─".repeat(50)));
}

function pushTriggerRows(
  rows: [string, string][],
  label: string,
  t: Order["conditional"],
): void {
  if (!t) return;
  const dir = t.trigger_direction === "ge" ? "≥" : "≤";
  rows.push([chalk.cyan.bold(`\n❖ ${label}`), ""]);
  rows.push([
    chalk.gray("  ↳ Trigger Price"),
    `${t.trigger_price} (when price ${dir} ${t.trigger_price})`,
  ]);
  rows.push([chalk.gray("  ↳ Order Type"), t.type]);
  rows.push([chalk.gray("  ↳ Time in Force"), t.time_in_force]);
  if (t.limit_price) rows.push([chalk.gray("  ↳ Limit Price"), t.limit_price]);
  if (t.execution_instructions.length)
    rows.push([
      chalk.gray("  ↳ Execution"),
      t.execution_instructions.join(", "),
    ]);
}

const COMMON_ORDER_COLUMNS: ColumnDef<Order>[] = [
  { header: "ID", key: "id" },
  { header: "Symbol", key: "symbol" },
  {
    header: "Side",
    accessor: (o) =>
      o.side.toUpperCase() === "BUY" ? chalk.green("BUY") : chalk.red("SELL"),
  },
  { header: "Type", key: "type" },
  { header: "Qty", key: "quantity", align: "right" },
  { header: "Filled", key: "filled_quantity", align: "right" },
  {
    header: "Price",
    accessor: (o) => o.price ?? chalk.dim("—"),
    align: "right",
  },
  {
    header: "Status",
    accessor: (o) => {
      switch (o.status?.toLowerCase()) {
        case "filled":
          return chalk.green(o.status);
        case "cancelled":
        case "rejected":
          return chalk.red(o.status);
        case "pending_new":
        case "new":
        case "partially_filled":
          return chalk.yellow(o.status);
        default:
          return o.status;
      }
    },
  },
];

const OPEN_ORDER_COLUMNS: ColumnDef<Order>[] = [
  ...COMMON_ORDER_COLUMNS,
  {
    header: "Conditions",
    accessor: (o) => {
      const conds: string[] = [];
      if (o.conditional?.trigger_price) {
        const dir = o.conditional.trigger_direction === "ge" ? "≥" : "≤";
        conds.push(`Trig ${dir}${o.conditional.trigger_price}`);
      }
      if (o.take_profit?.trigger_price)
        conds.push(`TP ${o.take_profit.trigger_price}`);
      if (o.stop_loss?.trigger_price)
        conds.push(`SL ${o.stop_loss.trigger_price}`);
      return conds.join(", ") || chalk.dim("—");
    },
  },
];

const HISTORY_ORDER_COLUMNS: ColumnDef<Order>[] = [...COMMON_ORDER_COLUMNS];

export function registerOrderCommand(program: Command): void {
  const order = program
    .command("order")
    .description("Order management")
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
  $ revx order place BTC-USD buy --qty 0.001 --market         Place market buy (base qty)
  $ revx order place BTC-USD buy --quote 100 --market         Place market buy (quote amount)
  $ revx order place BTC-USD sell --qty 0.001 --limit 95000   Place limit sell
  $ revx order open                                           List open/active orders
  $ revx order history --symbol BTC-USD                       Order history for pair
  $ revx order get <order-id>                                 Get order details
  $ revx order cancel <order-id>                              Cancel an order
  $ revx order cancel --all                                   Cancel all open orders
  $ revx order fills <order-id>                               Get order fills`,
    );

  order
    .command("place <symbol> <side>")
    .description(
      "Place an order (e.g. revx order place BTC-USD buy --qty 0.001 --limit 95000)",
    )
    .option("--qty <amount>", "Quantity in base currency (e.g. 0.001 for BTC)")
    .option("--quote <amount>", "Amount in quote currency (e.g. 100 for USD)")
    .option("--limit <price>", "Limit order price (required unless --market)")
    .option("--market", "Market order (required unless --limit)")
    .option("--post-only", "Post-only execution instruction")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        symbol: string,
        side: string,
        opts: {
          qty?: string;
          quote?: string;
          limit?: string;
          market?: boolean;
          postOnly?: boolean;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          const client = getClient({ requireAuth: true });

          if (!["buy", "sell"].includes(side.toLowerCase())) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Side must be 'buy' or 'sell'.")}`,
            );
            process.exit(1);
          }

          if (!opts.qty && !opts.quote) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify --qty <amount> or --quote <amount>.")}`,
            );
            process.exit(1);
          }

          if (opts.qty && opts.quote) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either --qty or --quote, not both.")}`,
            );
            process.exit(1);
          }

          const params: Parameters<typeof client.placeOrder>[0] = {
            symbol: symbol.toUpperCase(),
            side: side.toLowerCase() as "buy" | "sell",
          };

          const sizeField = opts.quote
            ? { quoteSize: opts.quote }
            : { baseSize: opts.qty! };

          if (opts.market) {
            params.market = sizeField;
          } else if (opts.limit) {
            params.limit = {
              price: opts.limit,
              ...sizeField,
              ...(opts.postOnly
                ? { executionInstructions: ["post_only"] }
                : {}),
            };
          } else {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify --limit <price> or --market.")}`,
            );
            process.exit(1);
          }

          await requireSessionAuth();
          const result = await client.placeOrder(params);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSuccess(`✓ Order placed successfully.\n`);
            printKeyValue([
              ["Venue Order ID", chalk.white.bold(result.data.venue_order_id)],
              ["Client Order ID", result.data.client_order_id],
              ["State", chalk.yellow(result.data.state)],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("open")
    .alias("active")
    .description("List open (active) orders")
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
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        symbols?: string;
        orderStates?: string;
        orderTypes?: string;
        side?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const queryOpts: Parameters<typeof client.getActiveOrders>[0] = {};
          if (opts.symbols)
            queryOpts.symbols = opts.symbols
              .split(",")
              .map((s) => s.toUpperCase());
          if (opts.orderStates)
            queryOpts.orderStates = opts.orderStates.split(",") as NonNullable<
              Parameters<typeof client.getActiveOrders>[0]
            >["orderStates"];
          if (opts.orderTypes)
            queryOpts.orderTypes = opts.orderTypes.split(",") as NonNullable<
              Parameters<typeof client.getActiveOrders>[0]
            >["orderTypes"];
          if (opts.side)
            queryOpts.side = opts.side.toLowerCase() as "buy" | "sell";
          if (opts.limit)
            queryOpts.limit = parsePositiveInt(opts.limit, "limit");
          if (opts.cursor) queryOpts.cursor = opts.cursor;

          const result = await client.getActiveOrders(queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader("Open Orders");
            if (result.data.length === 0) {
              console.log(chalk.gray("No open orders found.\n"));
            } else {
              printTable(result.data, OPEN_ORDER_COLUMNS);
              const nextCursor = (
                result as { metadata?: { next_cursor?: string } }
              ).metadata?.next_cursor;
              if (nextCursor) {
                console.log(
                  `\n  ${chalk.cyan("→ Next page cursor:")} ${chalk.white(nextCursor)}`,
                );
              }
            }
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
    .option("--cursor <cursor>", "Pagination cursor")
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
        cursor?: string;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const client = getClient({ requireAuth: true });
          const queryOpts: Parameters<typeof client.getHistoricalOrders>[0] =
            {};
          if (opts.symbols)
            queryOpts.symbols = opts.symbols
              .split(",")
              .map((s) => s.toUpperCase());
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
          if (opts.cursor) queryOpts.cursor = opts.cursor;

          const result = await client.getHistoricalOrders(queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            // --- MODIFIED: Pass the formatted period to the header ---
            const periodText = formatPeriod(
              queryOpts.startDate,
              queryOpts.endDate,
            );
            printSectionHeader("Order History", periodText);

            if (result.data.length === 0) {
              console.log(chalk.gray("No order history found.\n"));
            } else {
              printTable(result.data, HISTORY_ORDER_COLUMNS);
              const nextCursor = (
                result as { metadata?: { next_cursor?: string } }
              ).metadata?.next_cursor;
              if (nextCursor) {
                console.log(
                  `\n  ${chalk.cyan("→ Next page cursor:")} ${chalk.white(nextCursor)}`,
                );
              }
            }
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
            printSectionHeader(`Order Details`);

            const rows: [string, string][] = [
              ["ID", chalk.white.bold(o.id)],
              ["Client Order ID", o.client_order_id],
              ["Symbol", chalk.cyan(o.symbol)],
              [
                "Side",
                o.side.toUpperCase() === "BUY"
                  ? chalk.green("BUY")
                  : chalk.red("SELL"),
              ],
              ["Type", o.type],
              ["Quantity", o.quantity],
              ["Filled", o.filled_quantity],
              ["Remaining", o.leaves_quantity],
              ["Price", o.price ?? chalk.dim("—")],
              ...(o.average_fill_price
                ? [["Avg Fill Price", o.average_fill_price] as [string, string]]
                : []),
              ["Status", o.status],
              ...(o.reject_reason
                ? [
                    ["Reject Reason", chalk.red(o.reject_reason)] as [
                      string,
                      string,
                    ],
                  ]
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
    .command("cancel [order-id]")
    .description("Cancel an order, or all open orders with --all")
    .option("--all", "Cancel all open orders")
    .action(async (orderId: string | undefined, opts: { all?: boolean }) => {
      try {
        if (!orderId && !opts.all) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify an order ID or use --all to cancel all open orders.")}`,
          );
          process.exit(1);
        }
        if (orderId && opts.all) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either an order ID or --all, not both.")}`,
          );
          process.exit(1);
        }
        await requireSessionAuth();
        const client = getClient({ requireAuth: true });

        if (opts.all) {
          await client.cancelAllOrders();
          printSuccess("✓ All open orders cancelled.");
        } else {
          await client.cancelOrder(orderId!);
          printSuccess(`✓ Order ${chalk.cyan(orderId)} cancelled.`);
        }
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
            printSectionHeader(`Fills for Order: ${orderId}`);
            if (result.data.length === 0) {
              console.log(chalk.gray("No fills found for this order.\n"));
            } else {
              printTable(result.data, [
                { header: "Trade ID", key: "id" },
                { header: "Symbol", key: "symbol" },
                {
                  header: "Side",
                  accessor: (t) =>
                    t.side.toUpperCase() === "BUY"
                      ? chalk.green("BUY")
                      : chalk.red("SELL"),
                },
                { header: "Price", key: "price", align: "right" },
                { header: "Qty", key: "quantity", align: "right" },
                { header: "Maker", key: "maker" },
                {
                  header: "Time",
                  accessor: (t) => new Date(t.timestamp).toISOString(),
                },
              ]);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
