import { Command, Option } from "commander";
import chalk from "chalk";
import {
  type Order,
  type OrderPlacementResult,
  type TriggeredBy,
  type OnFill,
  type TwapOrderDetails,
  type TwapTriggeredBy,
  paginateWithDynamicWindows,
  HISTORICAL_ORDERS_API_LIMIT,
  type RevolutXClient,
  AuthNotConfiguredError,
  AuthenticationError,
  ForbiddenError,
  InsecureKeyPermissionsError,
  NotFoundError,
} from "@revolut/revolut-x-api";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import {
  OrderInputError,
  assertOnPriceStep,
  clientOrderIdOption,
  orderAmount,
  orderSymbol,
} from "../util/order-input.js";
import { resolveDateWindow, parsePositiveInt } from "../util/parse.js";
import {
  placementOutcome,
  uncertainPlacement,
  type PlacementContext,
  retryFailure,
} from "../util/order-outcome.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  printSuccess,
  formatLocalDateTime,
  LOCAL_TIME_NOTE,
  type ColumnDef,
} from "../output/formatter.js";

function formatPeriod(start?: number, end?: number): string {
  if (start && end) {
    return `Period: ${formatLocalDateTime(start)} to ${formatLocalDateTime(end)}`;
  }
  if (start) {
    return `Period: Since ${formatLocalDateTime(start)}`;
  }
  if (end) {
    return `Period: Up to ${formatLocalDateTime(end)}`;
  }
  return "Period: Default / Recent";
}

function notSent(err: unknown, note: string): unknown {
  if (
    err instanceof AuthNotConfiguredError ||
    err instanceof AuthenticationError ||
    err instanceof ForbiddenError ||
    err instanceof InsecureKeyPermissionsError
  ) {
    return err;
  }
  const reason = err instanceof Error ? err.message : String(err);
  const retry = retryFailure(err);
  return new Error(`${note} ${reason}${retry ? ` ${retry}` : ""}`, {
    cause: err,
  });
}

async function assertPriceOnStep(
  client: RevolutXClient,
  flag: string,
  price: string,
  symbol: string,
  unchanged: string,
): Promise<void> {
  const display = symbol.toUpperCase().replace("/", "-");
  let pairs: Awaited<ReturnType<RevolutXClient["getCurrencyPairs"]>>;
  try {
    pairs = await client.getCurrencyPairs();
  } catch (err) {
    throw notSent(
      err,
      `Could not read the ${display} price step, so ${unchanged}.`,
    );
  }
  const wanted = display.replace("-", "/");
  const pair = Object.entries(pairs).find(
    ([key]) => key.toUpperCase().replace("-", "/") === wanted,
  )?.[1];
  if (!pair) {
    throw new OrderInputError(
      `${display} is not a pair on Revolut X. See: revx market pairs`,
    );
  }
  assertOnPriceStep(flag, price, pair.quote_step, display);
}

function reportPlacement(
  result: { data: OrderPlacementResult },
  context: PlacementContext,
  opts: { json?: boolean; output?: string },
): void {
  const outcome = placementOutcome(result.data.state, context);
  const failed = outcome.kind === "error";
  const headline = failed
    ? `${chalk.red.bold("✖ Error:")} ${chalk.white(outcome.headline)}`
    : outcome.kind === "warning"
      ? chalk.yellow(`⚠ ${outcome.headline}`)
      : chalk.green(`✓ ${outcome.headline}`);
  if (isJsonOutput(opts)) {
    printJson(result);
    if (failed) console.error(headline);
  } else {
    const write = failed ? console.error : console.log;
    write(`${headline}\n`);
    printKeyValue(
      [
        ["Venue Order ID", chalk.white.bold(result.data.venue_order_id)],
        ["Client Order ID", result.data.client_order_id],
        ["State", chalk.yellow(result.data.state)],
      ],
      write,
    );
    if (outcome.hint) write(chalk.gray(`\n  ↳ ${outcome.hint}`));
  }
  if (failed) process.exitCode = 1;
}

function reportUncertainPlacement([headline, ...details]: string[]): void {
  console.error(`${chalk.red.bold("✖ Error:")} ${chalk.white(headline)}`);
  for (const line of details) console.error(chalk.gray(`  ↳ ${line}`));
  process.exitCode = 1;
}

function printSectionHeader(title: string, subtitle?: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  if (subtitle) {
    console.log(chalk.gray(`  ${subtitle}`));
  }
  console.log(chalk.dim("─".repeat(50)));
}

function isNullishFlagValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "none" || normalized === "null";
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

function pushTriggeredByRows(rows: [string, string][], tb: TriggeredBy): void {
  rows.push([chalk.cyan.bold(`\n❖ Triggered By`), ""]);
  rows.push([chalk.gray("  ↳ Reason"), tb.reason]);
  pushTriggerRows(rows, "Conditional Trigger", tb.conditional);
  pushTriggerRows(rows, "Take Profit", tb.take_profit);
  pushTriggerRows(rows, "Stop Loss", tb.stop_loss);
  if (tb.twap) pushTwapTriggeredByRows(rows, tb.twap);
}

function pushTwapTriggeredByRows(
  rows: [string, string][],
  twap: TwapTriggeredBy,
): void {
  rows.push([chalk.cyan.bold(`\n❖ TWAP Trigger`), ""]);
  rows.push([chalk.gray("  ↳ Parent Order ID"), twap.parent_id]);
  rows.push([chalk.gray("  ↳ Slice Index"), String(twap.slice_index)]);
}

function pushTwapDetailsRows(
  rows: [string, string][],
  twap: TwapOrderDetails,
): void {
  rows.push([chalk.cyan.bold(`\n❖ TWAP Details`), ""]);
  rows.push([chalk.gray("  ↳ Execution Type"), twap.type]);
  if (twap.price) rows.push([chalk.gray("  ↳ Price"), twap.price]);
  rows.push([chalk.gray("  ↳ Period"), `${twap.period}s`]);
  rows.push([chalk.gray("  ↳ Frequency"), `${twap.frequency}s`]);
  rows.push([chalk.gray("  ↳ Total Slices"), String(twap.total_slices)]);
  rows.push([
    chalk.gray("  ↳ Completed Slices"),
    String(twap.completed_slices),
  ]);
  rows.push([chalk.gray("  ↳ Started"), formatLocalDateTime(twap.start_date)]);
  rows.push([chalk.gray("  ↳ Ends"), formatLocalDateTime(twap.end_date)]);
}

function formatTwapConditions(twap: TwapOrderDetails): string {
  const parts = [
    `TWAP ${twap.type}`,
    `${twap.period}s/${twap.frequency}s`,
    `${twap.completed_slices}/${twap.total_slices} slices`,
  ];
  if (twap.price) parts[0] = `TWAP limit @${twap.price}`;
  return parts.join(", ");
}

function pushOnFillRows(rows: [string, string][], of: OnFill): void {
  rows.push([chalk.cyan.bold(`\n❖ On Fill (Exit Strategy)`), ""]);
  if (of.id) rows.push([chalk.gray("  ↳ Linked Order ID"), of.id]);
  pushTriggerRows(rows, "Take Profit", of.take_profit);
  pushTriggerRows(rows, "Stop Loss", of.stop_loss);
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
  { header: "Filled Qty", key: "filled_quantity", align: "right" },
  {
    header: "Filled Amt",
    accessor: (o) => o.filled_amount ?? chalk.dim("—"),
    align: "right",
  },
  {
    header: "Price",
    accessor: (o) => o.price ?? chalk.dim("—"),
    align: "right",
  },
  {
    header: "Avg Fill Price",
    accessor: (o) => o.average_fill_price ?? chalk.dim("—"),
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
      if (o.twap) return formatTwapConditions(o.twap);
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
  {
    header: "Created",
    accessor: (o) => formatLocalDateTime(o.created_date),
  },
];

const HISTORY_ORDER_COLUMNS: ColumnDef<Order>[] = [
  ...COMMON_ORDER_COLUMNS,
  {
    header: "Conditions",
    accessor: (o) => {
      if (o.twap) return formatTwapConditions(o.twap);
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
  {
    header: "Created",
    accessor: (o) => formatLocalDateTime(o.created_date),
  },
];

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
  $ revx order place BTC-USD buy --qty 0.001 --market            Place market buy (base qty)
  $ revx order place BTC-USD buy --quote 100 --market            Place market buy (quote amount)
  $ revx order place BTC-USD sell --qty 0.001 --limit 95000      Place limit sell (gtc by default)
  $ revx order place BTC-USD buy --qty 0.001 --limit 95000 --time-in-force ioc
  $ revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only
  $ revx order place BTC-USD sell --qty 0.001 --conditional --trigger-price 100000
  $ revx order place BTC-USD sell --qty 0.001 --tp 110000 --sl 90000   Take-profit/stop-loss order
  $ revx order open                                              List open/active orders
  $ revx order history --symbols BTC-USD                         Order history for pair
  $ revx order get <order-id>                                    Get order details
  $ revx order cancel <order-id>                                 Cancel an order
  $ revx order cancel --all                                      Cancel all open orders
  $ revx order replace <order-id> --price 96000                  Replace order limit price
  $ revx order replace <order-id> --qty 0.002                    Replace order qty (amount recalculated)
  $ revx order replace <order-id> --quote 150                    Replace order quote amount
  $ revx order replace <order-id> --time-in-force ioc            Replace order time in force
  $ revx order replace <order-id> --allow-taker                  Replace order to allow taker
  $ revx order replace <order-id> --tp 115000                    Replace take-profit trigger (whole trigger)
  $ revx order fills <order-id>                                  Get order fills`,
    );

  order
    .command("place")
    .description(
      "Place an order (e.g. revx order place BTC-USD buy --qty 0.001 --limit 95000)",
    )
    .argument("<symbol>", "Trading pair, e.g. BTC-USD")
    .argument("<side>", "Order side: buy or sell")
    .addHelpText(
      "after",
      `
Sizing (exactly one required; --qty only for take-profit/stop-loss):
  --qty    Size in base currency (e.g. 0.001 BTC)
  --quote  Size in quote currency (e.g. 100 USD)

Order type (exactly one required):
  --limit        Limit order at the given price
  --market       Market order at the best available price
  --conditional  Conditional (stop) order, triggers at --trigger-price
  --tp / --sl    Take-profit / stop-loss order (at least one required)

Conditional-only flags:
  --trigger-price          Price that activates the order
  --trigger-limit-price    Optional limit price for the order placed on trigger
                           (market order on trigger when omitted)

Take-profit/stop-loss-only flags (trigger directions are derived from side):
  --tp <price>     Take-profit trigger price
  --sl <price>     Stop-loss trigger price
  --tp-limit       Optional limit price for the take-profit leg
  --sl-limit       Optional limit price for the stop-loss leg

Limit-only flags (rejected with --market):
  --time-in-force  gtc (default) keeps the order open, ioc fills what it can
                   immediately and cancels the rest
  --post-only      Maker-only. The order is rejected if it would take liquidity.
                   Cannot be combined with --time-in-force ioc

Examples:
  $ revx order place BTC-USD buy --qty 0.001 --market              Market buy by base qty
  $ revx order place BTC-USD buy --quote 100 --market              Market buy by quote amount
  $ revx order place BTC-USD sell --qty 0.001 --limit 95000        Limit sell, gtc
  $ revx order place BTC-USD buy --qty 0.001 --limit 95000 --time-in-force ioc
  $ revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only
  $ revx order place BTC-USD sell --qty 0.001 --conditional --trigger-price 100000
  $ revx order place BTC-USD buy --qty 0.001 --conditional --trigger-price 90000 --trigger-limit-price 89900
  $ revx order place BTC-USD sell --qty 0.001 --tp 110000 --sl 90000
  $ revx order place BTC-USD sell --qty 0.001 --tp 110000 --tp-limit 109900
  $ revx order place BTC-USD buy --qty 0.001 --market --json       Output as JSON

The client order ID must be a UUID. One is generated unless you pass
--client-order-id <uuid>.
Scripts: pass your own --client-order-id <uuid> to know the ID even if the
reply is lost.`,
    )
    .option("--qty <amount>", "Quantity in base currency (e.g. 0.001 for BTC)")
    .option("--quote <amount>", "Amount in quote currency (e.g. 100 for USD)")
    .option(
      "--limit <price>",
      "Limit order price, a multiple of the pair's price step (required unless --market)",
    )
    .option("--market", "Market order (required unless --limit)")
    .option(
      "--conditional",
      "Conditional (stop) order; requires --trigger-price",
    )
    .option(
      "--trigger-price <price>",
      "Price that activates a conditional order",
    )
    .option(
      "--trigger-limit-price <price>",
      "Limit price for the order placed when a conditional order triggers",
    )
    .option("--tp <price>", "Take-profit trigger price")
    .option("--sl <price>", "Stop-loss trigger price")
    .option(
      "--tp-limit <price>",
      "Limit price for the take-profit leg (market on trigger when omitted)",
    )
    .option(
      "--sl-limit <price>",
      "Limit price for the stop-loss leg (market on trigger when omitted)",
    )
    .addOption(
      new Option(
        "--time-in-force <value>",
        "Time in force, limit orders only (default: gtc)",
      ).choices(["gtc", "ioc"]),
    )
    .option(
      "--post-only",
      "Post-only execution instruction (limit orders only)",
    )
    .option(
      "--client-order-id <uuid>",
      "Your own UUID for idempotency (a random UUID is generated if omitted)",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        symbol: string,
        side: string,
        opts: {
          qty?: string;
          quote?: string;
          limit?: string;
          market?: boolean;
          conditional?: boolean;
          triggerPrice?: string;
          triggerLimitPrice?: string;
          tp?: string;
          sl?: string;
          tpLimit?: string;
          slLimit?: string;
          timeInForce?: string;
          postOnly?: boolean;
          clientOrderId?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          if (!["buy", "sell"].includes(side.toLowerCase())) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Side must be 'buy' or 'sell'.")}`,
            );
            process.exit(1);
          }

          if (opts.qty === undefined && opts.quote === undefined) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify --qty <amount> or --quote <amount>.")}`,
            );
            process.exit(1);
          }

          if (opts.qty !== undefined && opts.quote !== undefined) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either --qty or --quote, not both.")}`,
            );
            process.exit(1);
          }

          const hasTpsl = Boolean(opts.tp || opts.sl);
          const orderTypes = [
            opts.market ? "--market" : undefined,
            opts.limit !== undefined ? "--limit" : undefined,
            opts.conditional ? "--conditional" : undefined,
            hasTpsl ? "--tp/--sl" : undefined,
          ].filter(Boolean);

          if (orderTypes.length === 0) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify an order type: --market, --limit <price>, --conditional, or --tp/--sl.")}`,
            );
            process.exit(1);
          }

          if (opts.market && opts.limit !== undefined) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either --limit <price> or --market, not both.")}`,
            );
            process.exit(1);
          }

          if (orderTypes.length > 1) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(`Specify only one order type: --market, --limit, --conditional, or --tp/--sl (got ${orderTypes.join(" and ")}).`)}`,
            );
            process.exit(1);
          }

          if (opts.conditional) {
            if (!opts.triggerPrice) {
              console.error(
                `${chalk.red.bold("✖ Error:")} ${chalk.white("--conditional requires --trigger-price <price>.")}`,
              );
              process.exit(1);
            }
          } else if (opts.triggerPrice || opts.triggerLimitPrice) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--trigger-price and --trigger-limit-price are only valid with --conditional.")}`,
            );
            process.exit(1);
          }

          if (hasTpsl && opts.quote) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Take-profit/stop-loss orders require --qty (base currency size).")}`,
            );
            process.exit(1);
          }

          if (opts.tpLimit && !opts.tp) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--tp-limit is only valid together with --tp <price>.")}`,
            );
            process.exit(1);
          }

          if (opts.slLimit && !opts.sl) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--sl-limit is only valid together with --sl <price>.")}`,
            );
            process.exit(1);
          }

          if ((opts.timeInForce || opts.postOnly) && !opts.limit) {
            const rejected = [
              opts.timeInForce ? "--time-in-force" : undefined,
              opts.postOnly ? "--post-only" : undefined,
            ].filter(Boolean);
            const subject =
              rejected.length > 1
                ? `${rejected.join(" and ")} apply`
                : `${rejected[0]} applies`;
            const conflicts = [
              opts.market ? "--market" : undefined,
              opts.conditional ? "--conditional" : undefined,
              hasTpsl ? "--tp/--sl" : undefined,
            ].filter(Boolean);
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(`${subject} to limit orders only and cannot be used with ${conflicts.join(" or ")}.`)}`,
            );
            process.exit(1);
          }

          if (opts.postOnly && opts.timeInForce === "ioc") {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--post-only cannot be combined with --time-in-force ioc.")}`,
            );
            process.exit(1);
          }

          const sizeField =
            opts.quote !== undefined
              ? { quoteSize: orderAmount("--quote", opts.quote) }
              : { baseSize: orderAmount("--qty", opts.qty!) };
          const limitPrice =
            opts.limit !== undefined
              ? orderAmount("--limit", opts.limit)
              : undefined;
          const pairSymbol = orderSymbol(symbol);
          const clientOrderId = clientOrderIdOption(opts.clientOrderId);

          const client = getClient({ requireAuth: true });

          const params: Parameters<typeof client.placeOrder>[0] = {
            symbol: pairSymbol,
            side: side.toLowerCase() as "buy" | "sell",
            clientOrderId,
          };

          if (limitPrice) {
            await assertPriceOnStep(
              client,
              "--limit",
              limitPrice,
              params.symbol,
              "the order was not sent",
            );
          }

          if (opts.market) {
            params.market = sizeField;
          } else if (opts.limit) {
            params.limit = {
              price: limitPrice!,
              ...sizeField,
              ...(opts.timeInForce
                ? { timeInForce: opts.timeInForce as "gtc" | "ioc" }
                : {}),
              ...(opts.postOnly
                ? { executionInstructions: ["post_only"] }
                : {}),
            };
          } else if (opts.conditional) {
            params.conditional = {
              triggerPrice: opts.triggerPrice!,
              ...(opts.triggerLimitPrice
                ? { limitPrice: opts.triggerLimitPrice }
                : {}),
              ...sizeField,
            };
          } else {
            params.tpsl = {
              baseSize: opts.qty!,
              ...(opts.tp
                ? {
                    takeProfit: {
                      triggerPrice: opts.tp,
                      ...(opts.tpLimit ? { limitPrice: opts.tpLimit } : {}),
                    },
                  }
                : {}),
              ...(opts.sl
                ? {
                    stopLoss: {
                      triggerPrice: opts.sl,
                      ...(opts.slLimit ? { limitPrice: opts.slLimit } : {}),
                    },
                  }
                : {}),
            };
          }

          let result: Awaited<ReturnType<typeof client.placeOrder>>;
          try {
            result = await client.placeOrder(params);
          } catch (err) {
            const lines = uncertainPlacement(err, {
              action: "place",
              symbol: params.symbol,
              clientOrderId,
            });
            if (!lines) throw err;
            reportUncertainPlacement(lines);
            return;
          }

          reportPlacement(
            result,
            {
              action: "place",
              orderId: result.data.venue_order_id,
              immediateOrCancel: !!opts.market || opts.timeInForce === "ioc",
              postOnly: !!opts.postOnly,
            },
            opts,
          );
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
      "Filter by types (comma-separated: limit,conditional,tpsl,twap)",
    )
    .addOption(
      new Option("--side <side>", "Filter by side").choices(["buy", "sell"]),
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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

          const result = await client.getActiveOrders(queryOpts);

          if (isJsonOutput(opts)) {
            printJson(result);
          } else {
            printSectionHeader("Open Orders");
            if (result.data.length === 0) {
              console.log(chalk.gray("No open orders found.\n"));
            } else {
              console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
              printTable(result.data, OPEN_ORDER_COLUMNS);
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
      "Filter by states (comma-separated: filled,cancelled,rejected,replaced,partially_filled)",
    )
    .option(
      "--order-types <types>",
      "Filter by types (comma-separated: market,limit,conditional,tpsl,twap)",
    )
    .option(
      "--start-date <date>",
      "Start date in local time (ISO, epoch ms, or relative: 7d, 1w, today)",
    )
    .option(
      "--end-date <date>",
      "End date in local time (ISO, epoch ms, or relative: today, yesterday)",
    )
    .option("--limit <n>", "Max results")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
          const baseOpts: Parameters<typeof client.getHistoricalOrders>[0] = {};
          if (opts.symbols)
            baseOpts.symbols = opts.symbols
              .split(",")
              .map((s) => s.toUpperCase());
          if (opts.orderStates)
            baseOpts.orderStates = opts.orderStates.split(",") as NonNullable<
              Parameters<typeof client.getHistoricalOrders>[0]
            >["orderStates"];
          if (opts.orderTypes)
            baseOpts.orderTypes = opts.orderTypes.split(",") as NonNullable<
              Parameters<typeof client.getHistoricalOrders>[0]
            >["orderTypes"];
          const userLimit = opts.limit
            ? parsePositiveInt(opts.limit, "limit")
            : undefined;

          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          const dates = resolveDateWindow(
            opts.startDate,
            opts.endDate,
            THIRTY_DAYS_MS,
          );

          const allOrders = await paginateWithDynamicWindows<Order>({
            fetchPage: (startDate, endDate, cursor, apiLimit) =>
              client.getHistoricalOrders({
                ...baseOpts,
                startDate,
                endDate,
                cursor,
                limit: apiLimit,
              }),
            startDate: dates.start,
            endDate: dates.end,
            apiLimit: HISTORICAL_ORDERS_API_LIMIT,
            userLimit,
          });

          if (isJsonOutput(opts)) {
            printJson({ data: allOrders });
          } else {
            const periodText = formatPeriod(dates.givenStart, dates.givenEnd);
            printSectionHeader("Order History", periodText);

            if (allOrders.length === 0) {
              console.log(chalk.gray("No order history found.\n"));
            } else {
              console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
              printTable(allOrders, HISTORY_ORDER_COLUMNS);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("get")
    .description("Get details of a specific order")
    .argument("<order-id>", "Venue order ID returned when the order was placed")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
            console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));

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
              ["Quantity", o.quantity ?? chalk.dim("—")],
              ...(o.amount ? [["Amount", o.amount] as [string, string]] : []),
              ["Filled Qty", o.filled_quantity],
              ...(o.filled_amount
                ? [["Filled Amt", o.filled_amount] as [string, string]]
                : []),
              ["Remaining", o.leaves_quantity ?? chalk.dim("—")],
              ["Price", o.price ?? chalk.dim("—")],
              ...(o.average_fill_price
                ? [["Avg Fill Price", o.average_fill_price] as [string, string]]
                : []),
              ...(o.total_fee
                ? [
                    [
                      "Total Fee",
                      `${o.total_fee}${o.fee_currency ? ` ${o.fee_currency}` : ""}`,
                    ] as [string, string],
                  ]
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
              ["Created", formatLocalDateTime(o.created_date)],
              ["Updated", formatLocalDateTime(o.updated_date)],
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

            if (o.twap) pushTwapDetailsRows(rows, o.twap);
            if (o.triggered_by) pushTriggeredByRows(rows, o.triggered_by);
            if (o.on_fill) pushOnFillRows(rows, o.on_fill);
            if (o.twap?.linked_ids?.length) {
              rows.push([chalk.cyan.bold(`\n❖ Linked Order IDs`), ""]);
              for (const linkedId of o.twap.linked_ids) {
                rows.push([chalk.gray("  ↳"), linkedId]);
              }
            }

            printKeyValue(rows);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("cancel")
    .description("Cancel an order, or all open orders with --all")
    .argument("[order-id]", "Venue order ID to cancel (omit when using --all)")
    .option("--all", "Cancel all open orders")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        orderId: string | undefined,
        opts: { all?: boolean; json?: boolean; output?: string },
      ) => {
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
          const client = getClient({ requireAuth: true });

          if (opts.all) {
            await client.cancelAllOrders();
          } else {
            await client.cancelOrder(orderId!);
          }
          if (isJsonOutput(opts)) {
            printJson({ cancelled: opts.all ? "all" : orderId });
          } else if (opts.all) {
            printSuccess("✓ All open orders cancelled.");
          } else {
            printSuccess(`✓ Order ${chalk.cyan(orderId)} cancelled.`);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("replace")
    .description(
      "Replace (modify) an existing order. Provide at least one of --price, --qty, --quote, --time-in-force, --post-only, --allow-taker, --trigger-price, --tp, --sl.",
    )
    .argument("<order-id>", "Venue order ID of the order to replace")
    .addHelpText(
      "after",
      `
Examples:
  $ revx order replace <order-id> --price 96000              Update the limit price
  $ revx order replace <order-id> --qty 0.002                Update base qty (amount recalculated)
  $ revx order replace <order-id> --quote 150                Update quote amount (qty recalculated)
  $ revx order replace <order-id> --time-in-force ioc        Fill immediately, cancel the rest
  $ revx order replace <order-id> --post-only                Maker-only execution
  $ revx order replace <order-id> --allow-taker              Allow taking liquidity
  $ revx order replace <order-id> --trigger-price 100000 --trigger-limit-price 99500
                                                              Replace a conditional trigger (whole trigger)
  $ revx order replace <order-id> --tp 115000 --tp-limit 114900
                                                              Replace the take-profit trigger (whole trigger)
  $ revx order replace <order-id> --sl none                  Remove the stop-loss leg

Changing only --price keeps a buy's quote amount (its quantity changes) and a
sell's quantity. To keep a buy's quantity, pass --qty <current qty> too.

Scripts: pass your own --client-order-id <uuid> to know the ID even if the
reply is lost.`,
    )
    .option(
      "--price <price>",
      "Replacement limit price, a multiple of the pair's price step",
    )
    .option(
      "--qty <amount>",
      "Replacement quantity in base currency (amount recalculated server-side)",
    )
    .option(
      "--quote <amount>",
      "Replacement amount in quote currency (qty recalculated server-side)",
    )
    .option(
      "--client-order-id <uuid>",
      "Your own UUID for the replacement (a random UUID is generated if omitted)",
    )
    .addOption(
      new Option(
        "--time-in-force <value>",
        "Replacement time in force: gtc keeps the order open, ioc fills immediately and cancels the rest",
      ).choices(["gtc", "ioc"]),
    )
    .option("--post-only", "Set execution_instructions to [post_only]")
    .option(
      "--allow-taker",
      "Set execution_instructions to [allow_taker] explicitly",
    )
    .option(
      "--trigger-price <price>",
      "Replacement trigger price for conditional orders; pass the whole trigger (with --trigger-limit-price for a limit leg); use 'none' to remove the trigger",
    )
    .option(
      "--trigger-limit-price <price>",
      "Limit price for the replacement conditional trigger (only with --trigger-price)",
    )
    .option(
      "--tp <price>",
      "Replacement take-profit trigger price (whole trigger is replaced); use 'none' to remove the leg",
    )
    .option(
      "--tp-limit <price>",
      "Limit price for the replacement take-profit trigger (only with --tp)",
    )
    .option(
      "--sl <price>",
      "Replacement stop-loss trigger price (whole trigger is replaced); use 'none' to remove the leg",
    )
    .option(
      "--sl-limit <price>",
      "Limit price for the replacement stop-loss trigger (only with --sl)",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(
      async (
        orderId: string,
        opts: {
          price?: string;
          qty?: string;
          quote?: string;
          clientOrderId?: string;
          timeInForce?: string;
          postOnly?: boolean;
          allowTaker?: boolean;
          triggerPrice?: string;
          triggerLimitPrice?: string;
          tp?: string;
          tpLimit?: string;
          sl?: string;
          slLimit?: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          if (opts.qty !== undefined && opts.quote !== undefined) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either --qty or --quote, not both.")}`,
            );
            process.exit(1);
          }

          if (opts.postOnly && opts.allowTaker) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify either --post-only or --allow-taker, not both.")}`,
            );
            process.exit(1);
          }

          if (opts.postOnly && opts.timeInForce === "ioc") {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--post-only cannot be combined with --time-in-force ioc.")}`,
            );
            process.exit(1);
          }

          if (opts.triggerLimitPrice && !opts.triggerPrice) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--trigger-limit-price is only valid together with --trigger-price <price>. To change only the limit price, pass the whole trigger again.")}`,
            );
            process.exit(1);
          }

          if (opts.tpLimit && !opts.tp) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--tp-limit is only valid together with --tp <price>. To change only the limit price, pass the whole trigger again.")}`,
            );
            process.exit(1);
          }

          if (opts.slLimit && !opts.sl) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--sl-limit is only valid together with --sl <price>. To change only the limit price, pass the whole trigger again.")}`,
            );
            process.exit(1);
          }

          if (
            opts.triggerLimitPrice &&
            isNullishFlagValue(opts.triggerPrice!)
          ) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--trigger-limit-price cannot be combined with --trigger-price none.")}`,
            );
            process.exit(1);
          }

          if (opts.tpLimit && isNullishFlagValue(opts.tp!)) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--tp-limit cannot be combined with --tp none.")}`,
            );
            process.exit(1);
          }

          if (opts.slLimit && isNullishFlagValue(opts.sl!)) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("--sl-limit cannot be combined with --sl none.")}`,
            );
            process.exit(1);
          }

          const hasTriggerUpdate = Boolean(
            opts.triggerPrice || opts.tp || opts.sl,
          );
          const limitOrderFlags = [
            opts.price ? "--price" : undefined,
            opts.timeInForce ? "--time-in-force" : undefined,
            opts.postOnly ? "--post-only" : undefined,
            opts.allowTaker ? "--allow-taker" : undefined,
          ].filter(Boolean);

          if (hasTriggerUpdate && limitOrderFlags.length > 0) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(`${limitOrderFlags.join(" and ")} apply to limit orders only and cannot be combined with --trigger-price, --tp or --sl.`)}`,
            );
            process.exit(1);
          }

          if (
            opts.price === undefined &&
            opts.qty === undefined &&
            opts.quote === undefined &&
            !opts.timeInForce &&
            !opts.postOnly &&
            !opts.allowTaker &&
            !opts.triggerPrice &&
            !opts.tp &&
            !opts.sl
          ) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white("Specify at least one of --price, --qty, --quote, --time-in-force, --post-only, --allow-taker, --trigger-price, --tp, --sl.")}`,
            );
            process.exit(1);
          }

          const price =
            opts.price !== undefined
              ? orderAmount("--price", opts.price)
              : undefined;
          const baseSize =
            opts.qty !== undefined ? orderAmount("--qty", opts.qty) : undefined;
          const quoteSize =
            opts.quote !== undefined
              ? orderAmount("--quote", opts.quote)
              : undefined;

          const client = getClient({ requireAuth: true });

          if (price) {
            let symbol: string | null = null;
            try {
              symbol = (await client.getOrder(orderId)).data.symbol;
            } catch (err) {
              if (!(err instanceof NotFoundError)) {
                throw notSent(
                  err,
                  `Could not read order ${orderId}, so it was not changed.`,
                );
              }
            }
            if (symbol) {
              await assertPriceOnStep(
                client,
                "--price",
                price,
                symbol,
                `order ${orderId} was not changed`,
              );
            }
          }

          const params: Parameters<typeof client.replaceOrder>[1] = {
            clientOrderId: clientOrderIdOption(opts.clientOrderId),
          };
          if (price) params.price = price;
          if (baseSize) params.baseSize = baseSize;
          if (quoteSize) params.quoteSize = quoteSize;
          if (opts.timeInForce)
            params.timeInForce = opts.timeInForce as "gtc" | "ioc";
          if (opts.postOnly) params.executionInstructions = ["post_only"];
          else if (opts.allowTaker)
            params.executionInstructions = ["allow_taker"];
          if (opts.triggerPrice) {
            params.conditional = isNullishFlagValue(opts.triggerPrice)
              ? null
              : {
                  triggerPrice: opts.triggerPrice,
                  ...(opts.triggerLimitPrice
                    ? { limitPrice: opts.triggerLimitPrice }
                    : {}),
                };
          }
          if (opts.tp) {
            params.takeProfit = isNullishFlagValue(opts.tp)
              ? null
              : {
                  triggerPrice: opts.tp,
                  ...(opts.tpLimit ? { limitPrice: opts.tpLimit } : {}),
                };
          }
          if (opts.sl) {
            params.stopLoss = isNullishFlagValue(opts.sl)
              ? null
              : {
                  triggerPrice: opts.sl,
                  ...(opts.slLimit ? { limitPrice: opts.slLimit } : {}),
                };
          }

          let result: Awaited<ReturnType<typeof client.replaceOrder>>;
          try {
            result = await client.replaceOrder(orderId, params);
          } catch (err) {
            const lines = uncertainPlacement(err, {
              action: "replace",
              originalOrderId: orderId,
              clientOrderId: params.clientOrderId,
            });
            if (!lines) throw err;
            reportUncertainPlacement(lines);
            return;
          }

          reportPlacement(
            result,
            {
              action: "replace",
              orderId: result.data.venue_order_id,
              originalOrderId: orderId,
              immediateOrCancel: opts.timeInForce === "ioc",
              postOnly: !!opts.postOnly,
            },
            opts,
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  order
    .command("fills")
    .description("Get fills for an order")
    .argument("<order-id>", "Venue order ID to list fills for")
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
              console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
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
                  accessor: (t) => formatLocalDateTime(t.timestamp),
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
