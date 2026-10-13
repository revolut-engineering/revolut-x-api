import { Command, Option } from "commander";
import chalk from "chalk";
import {
  ForegroundMonitor,
  TYPE_LABELS,
  type MonitorSpec,
} from "../engine/monitor.js";
import { loadConnections, type TelegramConnection } from "../db/store.js";
import { getClient } from "../util/client.js";
import { handleError } from "../util/errors.js";
import {
  MAX_CHECK_INTERVAL_SEC,
  MIN_CHECK_INTERVAL_SEC,
  MONITOR_CANDLES,
  MonitorOptionError,
  decimalOption,
  intervalOption,
  periodOption,
} from "../util/monitor-options.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(50)));
}

const TYPE_DOCS: Array<{
  command: string;
  alertType: string;
  description: string;
  flags: string;
  example: string;
}> = [
  {
    command: "price",
    alertType: "price",
    description:
      "Simple price threshold alert — triggers when the price is above or below a level, also at start.",
    flags: "--direction (above/below), --threshold (price level, required).",
    example: "revx monitor price BTC-USD --direction above --threshold 100000",
  },
  {
    command: "rsi",
    alertType: "rsi",
    description:
      "Relative Strength Index — triggers when RSI is above or below a threshold (overbought/oversold).",
    flags:
      "--direction (above/below), --threshold (0-100 scale, e.g. 70 = overbought, default 70), --period (default 14).",
    example: "revx monitor rsi ETH-USD --direction above --threshold 70",
  },
  {
    command: "ema-cross",
    alertType: "ema_cross",
    description:
      "EMA Crossover — triggers when fast EMA crosses above (bullish) or below (bearish) slow EMA. A trend already in place at start waits for a fresh cross.",
    flags:
      "--direction (bullish/bearish), --fast-period (default 9), --slow-period (default 21).",
    example: "revx monitor ema-cross BTC-USD --direction bullish",
  },
  {
    command: "macd",
    alertType: "macd",
    description:
      "MACD Crossover — triggers when MACD line crosses signal line. A trend already in place at start waits for a fresh cross.",
    flags:
      "--direction (bullish/bearish), --fast (default 12), --slow (default 26), --signal (default 9).",
    example: "revx monitor macd BTC-USD --direction bullish",
  },
  {
    command: "bollinger",
    alertType: "bollinger",
    description:
      "Bollinger Bands — triggers when the price is at or beyond the upper/lower band.",
    flags:
      "--band (upper/lower), --period (default 20), --std-mult (default 2).",
    example: "revx monitor bollinger BTC-USD --band upper",
  },
  {
    command: "volume-spike",
    alertType: "volume_spike",
    description:
      "Volume Spike — triggers when current volume exceeds a multiple of the average.",
    flags: "--period (default 20), --multiplier (default 2.0).",
    example: "revx monitor volume-spike BTC-USD",
  },
  {
    command: "spread",
    alertType: "spread",
    description:
      "Bid-Ask Spread — triggers when the spread percentage is above or below a threshold.",
    flags:
      "--direction (above/below), --threshold (spread in %, e.g. 0.5 = 0.5%, default 0.5).",
    example: "revx monitor spread BTC-USD --direction above --threshold 0.5",
  },
  {
    command: "obi",
    alertType: "obi",
    description:
      "Order Book Imbalance — triggers when the buy/sell volume imbalance is above or below a threshold.",
    flags:
      "--direction (above/below), --threshold (ratio from -1.0 to 1.0, e.g. 0.3 = 30% buy imbalance, default 0.3).",
    example: "revx monitor obi BTC-USD --direction above --threshold 0.3",
  },
  {
    command: "price-change",
    alertType: "price_change_pct",
    description:
      "Price Change % — triggers when price has risen or fallen by at least X% over the last N 1-hour candles.",
    flags:
      "--direction (rise/fall), --threshold (% change, e.g. 5 = 5%, default 5.0), --lookback (1h candles, default 24).",
    example:
      "revx monitor price-change BTC-USD --direction rise --threshold 5.0",
  },
  {
    command: "atr-breakout",
    alertType: "atr_breakout",
    description:
      "ATR Breakout — triggers when price moves more than a multiple of ATR from previous close.",
    flags: "--period (default 14), --multiplier (default 1.5).",
    example: "revx monitor atr-breakout BTC-USD",
  },
];

async function assertTradedPair(pair: string): Promise<void> {
  const pairs = await getClient({ requireAuth: true }).getCurrencyPairs();
  const info = pairs[pair.replace("-", "/")];
  if (!info) {
    throw new Error(
      `${pair} is not a trading pair on Revolut X. See the pairs with: revx market pairs`,
    );
  }
  if (info.status !== "active") {
    throw new Error(
      `${pair} is not trading right now (status ${info.status}).`,
    );
  }
}

async function startMonitor(
  pair: string,
  alertType: string,
  buildConfig: () => Record<string, unknown>,
  interval: string,
): Promise<void> {
  pair = pair.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(pair)) {
    console.error(
      `${chalk.red.bold("✖ Error:")} ${chalk.white(`Invalid pair format '${chalk.cyan(pair)}'. Expected e.g. 'BTC-USD'.`)}`,
    );
    process.exit(1);
  }

  let config: Record<string, unknown>;
  let intervalSec: number;
  let connections: TelegramConnection[];
  try {
    config = buildConfig();
    intervalSec = intervalOption(interval);
    connections = loadConnections().filter((c) => c.enabled);
    await assertTradedPair(pair);
  } catch (err) {
    handleError(err);
  }

  if (connections.length === 0) {
    console.log(
      chalk.yellow.bold("! Warning:") +
        chalk.white(" No active Telegram connections found."),
    );
    console.log(
      chalk.gray(
        "  ↳ Alerts will display in the terminal but no notifications will be sent.",
      ),
    );
    console.log(
      chalk.gray(
        "  ↳ Add one with: revx connector telegram add --token <token> --chat-id <id>\n",
      ),
    );
  }

  const spec: MonitorSpec = { pair, alertType, config, intervalSec };

  ForegroundMonitor.printBanner(spec, connections.length);

  const monitor = new ForegroundMonitor(spec, connections);

  const shutdown = () => {
    console.log(chalk.dim("\n  \u25CB Monitor stopped"));
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await monitor.run();
  } catch (err) {
    console.error(
      `${chalk.red.bold("✖ Error:")} ${chalk.white(err instanceof Error ? err.message : String(err))}`,
    );
    process.exit(1);
  }
}

export function registerMonitorCommand(program: Command): void {
  const monitor = program
    .command("monitor")
    .description("Monitor a trading pair for alert conditions")
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
  $ revx monitor price BTC-USD --direction above --threshold 100000
  $ revx monitor rsi ETH-USD --direction above --threshold 70 --period 14
  $ revx monitor ema-cross BTC-USD --direction bullish
  $ revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9
  $ revx monitor bollinger BTC-USD --band upper
  $ revx monitor volume-spike BTC-USD
  $ revx monitor spread BTC-USD --direction above --threshold 0.5
  $ revx monitor obi BTC-USD --direction above --threshold 0.3
  $ revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24
  $ revx monitor atr-breakout BTC-USD
  $ revx monitor price BTC-USD --threshold 100000 --interval 30   Poll every 30s
  $ revx monitor types                                            Describe every monitor

Every monitor runs in the foreground until Ctrl-C. Triggered alerts always print to the
terminal; to also receive notifications, register a connector first:
  $ revx connector telegram add --token <token> --chat-id <id>
`,
    );

  monitor
    .command("price")
    .description(
      "Price threshold — triggers when the price is above or below a level",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option("--direction <direction>", "Cross direction")
        .choices(["above", "below"])
        .default("above"),
    )
    .requiredOption("--threshold <value>", "Price level to watch")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "price",
          () => ({
            direction: opts.direction,
            threshold: decimalOption("--threshold", opts.threshold, {
              above: 0,
            }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("rsi")
    .description(
      "RSI — triggers when the Relative Strength Index is above or below a threshold",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option("--direction <direction>", "Cross direction")
        .choices(["above", "below"])
        .default("above"),
    )
    .option(
      "--threshold <value>",
      "RSI threshold on a 0-100 scale (70 = overbought, 30 = oversold)",
      "70",
    )
    .option("--period <n>", "RSI calculation period", "14")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: {
          direction: string;
          threshold: string;
          period: string;
          interval: string;
        },
      ) => {
        await startMonitor(
          pair,
          "rsi",
          () => ({
            direction: opts.direction,
            threshold: decimalOption("--threshold", opts.threshold, {
              above: 0,
              below: 100,
            }),
            period: periodOption("--period", opts.period, 2),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("ema-cross")
    .description(
      "EMA Crossover — triggers when fast EMA crosses above or below slow EMA, after the first check",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option(
        "--direction <direction>",
        "bullish = fast crosses above slow, bearish = fast crosses below slow",
      )
        .choices(["bullish", "bearish"])
        .default("bullish"),
    )
    .option("--fast-period <n>", "Fast EMA period", "9")
    .option("--slow-period <n>", "Slow EMA period", "21")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: {
          direction: string;
          fastPeriod: string;
          slowPeriod: string;
          interval: string;
        },
      ) => {
        await startMonitor(
          pair,
          "ema_cross",
          () => {
            const fast = periodOption("--fast-period", opts.fastPeriod);
            const slow = periodOption("--slow-period", opts.slowPeriod);
            if (fast >= slow) {
              throw new MonitorOptionError(
                `--fast-period must be below --slow-period, got ${fast} and ${slow}.`,
              );
            }
            return {
              direction: opts.direction,
              fast_period: fast,
              slow_period: slow,
            };
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("macd")
    .description(
      "MACD Crossover — triggers when MACD line crosses signal line, after the first check",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option(
        "--direction <direction>",
        "bullish = MACD crosses above signal, bearish = MACD crosses below signal",
      )
        .choices(["bullish", "bearish"])
        .default("bullish"),
    )
    .option("--fast <n>", "Fast EMA period", "12")
    .option("--slow <n>", "Slow EMA period", "26")
    .option("--signal <n>", "Signal line period", "9")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: {
          direction: string;
          fast: string;
          slow: string;
          signal: string;
          interval: string;
        },
      ) => {
        await startMonitor(
          pair,
          "macd",
          () => {
            const fast = periodOption("--fast", opts.fast);
            const slow = periodOption("--slow", opts.slow);
            const signal = periodOption("--signal", opts.signal, 2);
            if (fast >= slow) {
              throw new MonitorOptionError(
                `--fast must be below --slow, got ${fast} and ${slow}.`,
              );
            }
            if (slow + signal > MONITOR_CANDLES) {
              throw new MonitorOptionError(
                `--slow plus --signal can be at most ${MONITOR_CANDLES}, got ${slow + signal}. The monitor reads the last ${MONITOR_CANDLES} hourly candles.`,
              );
            }
            return { direction: opts.direction, fast, slow, signal };
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("bollinger")
    .description(
      "Bollinger Bands — triggers when the price is at or beyond the upper/lower band",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option("--band <band>", "Band to watch")
        .choices(["upper", "lower"])
        .default("upper"),
    )
    .option("--period <n>", "Bollinger period", "20")
    .option("--std-mult <n>", "Standard deviation multiplier", "2")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: {
          band: string;
          period: string;
          stdMult: string;
          interval: string;
        },
      ) => {
        await startMonitor(
          pair,
          "bollinger",
          () => ({
            band: opts.band,
            period: periodOption("--period", opts.period, 2),
            std_mult: decimalOption("--std-mult", opts.stdMult, { above: 0 }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("volume-spike")
    .description(
      "Volume Spike — triggers when volume exceeds a multiple of the average",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .option("--period <n>", "Average volume period", "20")
    .option("--multiplier <n>", "Volume multiplier threshold", "2.0")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: { period: string; multiplier: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "volume_spike",
          () => ({
            period: periodOption("--period", opts.period),
            multiplier: decimalOption("--multiplier", opts.multiplier, {
              above: 0,
            }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("spread")
    .description(
      "Bid-Ask Spread — triggers when the spread percentage is above or below a threshold",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option("--direction <direction>", "Cross direction")
        .choices(["above", "below"])
        .default("above"),
    )
    .option("--threshold <value>", "Spread threshold in % (0.5 = 0.5%)", "0.5")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "spread",
          () => ({
            direction: opts.direction,
            threshold: decimalOption("--threshold", opts.threshold, {
              min: 0,
            }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("obi")
    .description(
      "Order Book Imbalance — triggers when the buy/sell imbalance is above or below a threshold",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option("--direction <direction>", "Cross direction")
        .choices(["above", "below"])
        .default("above"),
    )
    .option(
      "--threshold <value>",
      "Imbalance ratio from -1.0 to 1.0 (0.3 = 30% buy imbalance)",
      "0.3",
    )
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "obi",
          () => ({
            direction: opts.direction,
            threshold: decimalOption("--threshold", opts.threshold, {
              min: -1,
              max: 1,
            }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("price-change")
    .description(
      "Price Change % — triggers when price rises or falls by X% over N hours",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .addOption(
      new Option(
        "--direction <direction>",
        "Move direction to watch for (above/below are accepted synonyms of rise/fall)",
      )
        .choices(["rise", "fall", "above", "below"])
        .default("rise"),
    )
    .option("--threshold <value>", "Minimum % change (5 = 5%)", "5.0")
    .option("--lookback <n>", "Lookback in 1-hour candles", "24")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: {
          direction: string;
          threshold: string;
          lookback: string;
          interval: string;
        },
      ) => {
        await startMonitor(
          pair,
          "price_change_pct",
          () => ({
            direction: opts.direction,
            threshold: decimalOption("--threshold", opts.threshold, {
              above: 0,
            }),
            lookback: periodOption("--lookback", opts.lookback),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("atr-breakout")
    .description(
      "ATR Breakout — triggers when price moves more than a multiple of ATR",
    )
    .argument("<pair>", "Trading pair, e.g. BTC-USD")
    .option("--period <n>", "ATR period", "14")
    .option("--multiplier <n>", "ATR multiplier", "1.5")
    .option("--interval <sec>", "Check interval in seconds (5 to 86400)", "10")
    .action(
      async (
        pair: string,
        opts: { period: string; multiplier: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "atr_breakout",
          () => ({
            period: periodOption("--period", opts.period),
            multiplier: decimalOption("--multiplier", opts.multiplier, {
              above: 0,
            }),
          }),
          opts.interval,
        );
      },
    );

  monitor
    .command("types")
    .description("List supported monitor types")
    .action(() => {
      printSectionHeader("Supported Monitor Types");
      for (const doc of TYPE_DOCS) {
        const label = TYPE_LABELS[doc.alertType] ?? doc.alertType;
        const padded = doc.command.padEnd(20);
        console.log(
          `  ${chalk.cyan.bold("\u25C6 " + padded)} ${chalk.white.bold(label)}`,
        );
        console.log(chalk.gray(`      ${doc.description}`));
        console.log(chalk.dim(`      Flags:   ${doc.flags}`));
        console.log(chalk.dim(`      Example: ${doc.example}\n`));
      }
      console.log(chalk.gray(`  ↳ ${TYPE_DOCS.length} types available`));
      console.log(
        chalk.gray(
          `  ↳ Periods are whole numbers up to ${MONITOR_CANDLES - 1}, since a monitor reads the last ${MONITOR_CANDLES} hourly candles. --interval is from ${MIN_CHECK_INTERVAL_SEC} to ${MAX_CHECK_INTERVAL_SEC} seconds.\n`,
        ),
      );
    });
}
