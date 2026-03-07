import { Command } from "commander";
import {
  loadAlerts,
  createAlert,
  getAlert,
  updateAlert,
  deleteAlert,
  type Alert,
} from "../db/store.js";
import { handleError } from "../util/errors.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  printSuccess,
  type ColumnDef,
} from "../output/formatter.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

const VALID_ALERT_TYPES = new Set([
  "price",
  "rsi",
  "ema_cross",
  "macd",
  "bollinger",
  "volume_spike",
  "spread",
  "obi",
  "price_change_pct",
  "atr_breakout",
]);

// Keep in sync with mcp/src/tools/alerts.ts _ALERT_TYPE_DOCS
const ALERT_TYPE_DOCS: Record<
  string,
  { description: string; config_fields: string; example: string }
> = {
  price: {
    description:
      "Simple price threshold alert — triggers when price crosses above or below a level.",
    config_fields: "direction (above/below), threshold (price level).",
    example:
      "revx alerts create BTC-USD --type price --direction above --threshold 100000",
  },
  rsi: {
    description:
      "Relative Strength Index — triggers when RSI crosses a threshold (overbought/oversold).",
    config_fields:
      "period (default 14), direction (above/below), threshold (0-100 scale, e.g. 70 = overbought, 30 = oversold).",
    example:
      'revx alerts create BTC-USD --type rsi --config \'{"period":14,"direction":"above","threshold":"70"}\'',
  },
  ema_cross: {
    description:
      "EMA Crossover — triggers when fast EMA crosses above (bullish) or below (bearish) slow EMA.",
    config_fields:
      "fast_period (default 9), slow_period (default 21), direction (bullish/bearish).",
    example:
      'revx alerts create BTC-USD --type ema_cross --config \'{"fast_period":9,"slow_period":21,"direction":"bullish"}\'',
  },
  macd: {
    description:
      "MACD Crossover — triggers when MACD line crosses signal line.",
    config_fields:
      "fast (default 12), slow (default 26), signal (default 9), direction (bullish/bearish).",
    example:
      'revx alerts create BTC-USD --type macd --config \'{"fast":12,"slow":26,"signal":9,"direction":"bullish"}\'',
  },
  bollinger: {
    description:
      "Bollinger Bands — triggers when price touches or crosses upper/lower band.",
    config_fields:
      "period (default 20), std_mult (default 2), band (upper/lower).",
    example:
      'revx alerts create BTC-USD --type bollinger --config \'{"period":20,"std_mult":"2","band":"upper"}\'',
  },
  volume_spike: {
    description:
      "Volume Spike — triggers when current volume exceeds a multiple of the average.",
    config_fields: "period (default 20), multiplier (default 2.0).",
    example:
      'revx alerts create BTC-USD --type volume_spike --config \'{"period":20,"multiplier":"2.0"}\'',
  },
  spread: {
    description:
      "Bid-Ask Spread — triggers when spread percentage crosses a threshold.",
    config_fields:
      "direction (above/below), threshold (spread in %, e.g. 0.5 = 0.5%).",
    example:
      'revx alerts create BTC-USD --type spread --config \'{"direction":"above","threshold":"0.5"}\'',
  },
  obi: {
    description:
      "Order Book Imbalance — triggers when buy/sell volume imbalance crosses a threshold.",
    config_fields:
      "direction (above/below), threshold (ratio -1.0 to 1.0, e.g. 0.3 = 30% buy imbalance).",
    example:
      'revx alerts create BTC-USD --type obi --config \'{"direction":"above","threshold":"0.3"}\'',
  },
  price_change_pct: {
    description:
      "Price Change % — triggers when price has risen or fallen by at least X% over the last N 1-hour candles.",
    config_fields:
      "lookback (1h candle count, default 24), direction (rise/fall), threshold (% change, e.g. 5 = 5%; always positive).",
    example:
      'revx alerts create BTC-USD --type price_change_pct --config \'{"lookback":24,"direction":"rise","threshold":"5.0"}\'',
  },
  atr_breakout: {
    description:
      "ATR Breakout — triggers when price moves more than a multiple of ATR from previous close.",
    config_fields: "period (default 14), multiplier (default 1.5).",
    example:
      'revx alerts create BTC-USD --type atr_breakout --config \'{"period":14,"multiplier":"1.5"}\'',
  },
};

const ALERT_COLUMNS: ColumnDef<Alert>[] = [
  { header: "ID", accessor: (a) => a.id.slice(0, 8) },
  { header: "Pair", key: "pair" },
  { header: "Type", key: "alert_type" },
  { header: "Enabled", accessor: (a) => (a.enabled ? "yes" : "no") },
  {
    header: "Interval",
    accessor: (a) => `${a.poll_interval_sec}s`,
    align: "right",
  },
  { header: "Created", accessor: (a) => a.created_at.slice(0, 19) },
];

export function registerAlertsCommand(program: Command): void {
  const alerts = program
    .command("alerts")
    .description("Alert management")
    .addHelpText(
      "after",
      `
Examples:
  $ revx alerts create BTC-USD --type price --direction above --threshold 100000
  $ revx alerts create ETH-USD --type rsi --config '{"period":14,"direction":"above","threshold":"70"}'
  $ revx alerts list                   List all alerts
  $ revx alerts get <id>              Get alert details
  $ revx alerts enable <id>           Enable an alert
  $ revx alerts disable <id>          Disable an alert
  $ revx alerts delete <id>           Delete an alert
  $ revx alerts types                 List supported alert types`,
    );

  alerts
    .command("create <pair>")
    .description("Create a market alert")
    .option("--type <type>", "Alert type (default: price)", "price")
    .option(
      "--direction <dir>",
      'For price alerts: "above" or "below"',
      "above",
    )
    .option(
      "--threshold <value>",
      "Threshold value (price level for price type; see 'revx alerts types' for other types)",
    )
    .option("--config <json>", "JSON config for non-price alerts")
    .option("--interval <sec>", "Poll interval in seconds (min 5)", "10")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (
        pair: string,
        opts: {
          type: string;
          direction: string;
          threshold?: string;
          config?: string;
          interval: string;
          json?: boolean;
          output?: string;
        },
      ) => {
        try {
          pair = pair.trim().toUpperCase();
          if (!SYMBOL_PATTERN.test(pair)) {
            console.error(
              `Error: Invalid pair format '${pair}'. Expected e.g. 'BTC-USD'.`,
            );
            process.exit(1);
          }

          const alertType = opts.type.trim().toLowerCase();
          if (!VALID_ALERT_TYPES.has(alertType)) {
            console.error(
              `Error: Unknown alert type '${alertType}'. Run 'revx alerts types' for options.`,
            );
            process.exit(1);
          }

          const pollInterval = Math.max(5, parseInt(opts.interval, 10) || 10);
          let config: Record<string, unknown>;

          if (alertType === "price") {
            const direction = opts.direction.trim().toLowerCase();
            if (direction !== "above" && direction !== "below") {
              console.error("Error: --direction must be 'above' or 'below'.");
              process.exit(1);
            }
            if (!opts.threshold) {
              console.error("Error: --threshold is required for price alerts.");
              process.exit(1);
            }
            if (isNaN(Number(opts.threshold))) {
              console.error(
                `Error: Invalid threshold '${opts.threshold}'. Must be a number.`,
              );
              process.exit(1);
            }
            config = { direction, threshold: opts.threshold };
          } else if (opts.config) {
            try {
              config = JSON.parse(opts.config) as Record<string, unknown>;
              if (
                typeof config !== "object" ||
                config === null ||
                Array.isArray(config)
              ) {
                console.error("Error: --config must be a JSON object.");
                process.exit(1);
              }
            } catch {
              console.error("Error: Invalid JSON in --config.");
              process.exit(1);
            }
          } else {
            console.error(
              `Error: --config is required for '${alertType}' alerts. Run 'revx alerts types' for details.`,
            );
            process.exit(1);
          }

          const alert = createAlert(pair, alertType, config, pollInterval);

          if (isJsonOutput(opts)) {
            printJson(alert);
          } else {
            printSuccess("Alert created.");
            printKeyValue([
              ["ID", alert.id],
              ["Pair", alert.pair],
              ["Type", alert.alert_type],
              ["Config", JSON.stringify(alert.config)],
              ["Interval", `${alert.poll_interval_sec}s`],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  alerts
    .command("list")
    .description("List all alerts")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const all = loadAlerts();
        if (isJsonOutput(opts)) {
          printJson(all);
        } else {
          printTable(all, ALERT_COLUMNS);
        }
      } catch (err) {
        handleError(err);
      }
    });

  alerts
    .command("get <alert-id>")
    .description("Get alert details")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (alertId: string, opts: { json?: boolean; output?: string }) => {
        try {
          const alert = getAlert(alertId);
          if (!alert) {
            console.error(`Error: Alert ${alertId} not found.`);
            process.exit(1);
          }
          if (isJsonOutput(opts)) {
            printJson(alert);
          } else {
            printKeyValue([
              ["ID", alert.id],
              ["Pair", alert.pair],
              ["Type", alert.alert_type],
              ["Config", JSON.stringify(alert.config)],
              ["Enabled", alert.enabled ? "yes" : "no"],
              ["Interval", `${alert.poll_interval_sec}s`],
              ["Created", alert.created_at],
              ["Updated", alert.updated_at],
            ]);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  alerts
    .command("enable <alert-id>")
    .description("Enable an alert")
    .action(async (alertId: string) => {
      try {
        const result = updateAlert(alertId, { enabled: true });
        if (!result) {
          console.error(`Error: Alert ${alertId} not found.`);
          process.exit(1);
        }
        printSuccess(`Alert ${alertId} enabled.`);
      } catch (err) {
        handleError(err);
      }
    });

  alerts
    .command("disable <alert-id>")
    .description("Disable an alert")
    .action(async (alertId: string) => {
      try {
        const result = updateAlert(alertId, { enabled: false });
        if (!result) {
          console.error(`Error: Alert ${alertId} not found.`);
          process.exit(1);
        }
        printSuccess(`Alert ${alertId} disabled.`);
      } catch (err) {
        handleError(err);
      }
    });

  alerts
    .command("delete <alert-id>")
    .description("Delete an alert")
    .action(async (alertId: string) => {
      try {
        const ok = deleteAlert(alertId);
        if (!ok) {
          console.error(`Error: Alert ${alertId} not found.`);
          process.exit(1);
        }
        printSuccess(`Alert ${alertId} deleted.`);
      } catch (err) {
        handleError(err);
      }
    });

  alerts
    .command("types")
    .description("List supported alert types")
    .action(() => {
      console.log("Supported Alert Types\n" + "=".repeat(60) + "\n");
      for (const [name, doc] of Object.entries(ALERT_TYPE_DOCS)) {
        console.log(`  ${name}`);
        console.log(`    ${doc.description}`);
        console.log(`    Config: ${doc.config_fields}`);
        console.log(`    Example: ${doc.example}`);
        console.log();
      }
      console.log(`Total: ${Object.keys(ALERT_TYPE_DOCS).length} alert types`);
    });
}
