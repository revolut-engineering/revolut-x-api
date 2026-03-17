import { Command } from "commander";
import chalk from "chalk";
import {
  ForegroundMonitor,
  TYPE_LABELS,
  type MonitorSpec,
} from "../engine/monitor.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

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
      "Simple price threshold alert — triggers when price crosses above or below a level.",
    flags: "--direction (above/below), --threshold (price level, required).",
    example: "revx monitor price BTC-USD --direction above --threshold 100000",
  },
  {
    command: "rsi",
    alertType: "rsi",
    description:
      "Relative Strength Index — triggers when RSI crosses a threshold (overbought/oversold).",
    flags:
      "--direction (above/below), --threshold (0-100 scale, e.g. 70 = overbought; default 70), --period (default 14).",
    example: "revx monitor rsi ETH-USD --direction above --threshold 70",
  },
  {
    command: "ema-cross",
    alertType: "ema_cross",
    description:
      "EMA Crossover — triggers when fast EMA crosses above (bullish) or below (bearish) slow EMA.",
    flags:
      "--direction (bullish/bearish), --fast-period (default 9), --slow-period (default 21).",
    example: "revx monitor ema-cross BTC-USD --direction bullish",
  },
  {
    command: "macd",
    alertType: "macd",
    description:
      "MACD Crossover — triggers when MACD line crosses signal line.",
    flags:
      "--direction (bullish/bearish), --fast (default 12), --slow (default 26), --signal (default 9).",
    example: "revx monitor macd BTC-USD --direction bullish",
  },
  {
    command: "bollinger",
    alertType: "bollinger",
    description:
      "Bollinger Bands — triggers when price touches or crosses upper/lower band.",
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
      "Bid-Ask Spread — triggers when spread percentage crosses a threshold.",
    flags:
      "--direction (above/below), --threshold (spread in %, e.g. 0.5 = 0.5%; default 0.5).",
    example: "revx monitor spread BTC-USD --direction above --threshold 0.5",
  },
  {
    command: "obi",
    alertType: "obi",
    description:
      "Order Book Imbalance — triggers when buy/sell volume imbalance crosses a threshold.",
    flags:
      "--direction (above/below), --threshold (ratio from -1.0 to 1.0, e.g. 0.3 = 30% buy imbalance; default 0.3).",
    example: "revx monitor obi BTC-USD --direction above --threshold 0.3",
  },
  {
    command: "price-change",
    alertType: "price_change_pct",
    description:
      "Price Change % — triggers when price has risen or fallen by at least X% over the last N 1-hour candles.",
    flags:
      "--direction (rise/fall), --threshold (% change, e.g. 5 = 5%; default 5.0), --lookback (1h candles, default 24).",
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

async function startMonitor(
  pair: string,
  alertType: string,
  config: Record<string, unknown>,
  interval: string,
): Promise<void> {
  pair = pair.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(pair)) {
    console.error(`Invalid pair format '${pair}'. Expected e.g. 'BTC-USD'.`);
    process.exit(1);
  }

  const intervalSec = Math.max(5, parseInt(interval, 10) || 10);

  const spec: MonitorSpec = { pair, alertType, config, intervalSec };

  ForegroundMonitor.printBanner(spec);

  const monitor = new ForegroundMonitor(spec);

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
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function registerMonitorCommand(program: Command): void {
  const monitor = program
    .command("monitor")
    .description("Monitor a trading pair for alert conditions")
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
  $ revx monitor types
`,
    );

  monitor
    .command("price <pair>")
    .description(
      "Price threshold — triggers when price crosses above or below a level",
    )
    .option("--direction <dir>", "above or below", "above")
    .option("--threshold <value>", "Price level (required)")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold?: string; interval: string },
      ) => {
        if (!opts.threshold) {
          console.error("Error: --threshold is required for price alerts.");
          process.exit(1);
        }
        await startMonitor(
          pair,
          "price",
          {
            direction: opts.direction,
            threshold: opts.threshold,
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("rsi <pair>")
    .description(
      "RSI — triggers when Relative Strength Index crosses a threshold",
    )
    .option("--direction <dir>", "above or below", "above")
    .option("--threshold <value>", "RSI threshold (0-100)", "70")
    .option("--period <n>", "RSI calculation period", "14")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
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
          {
            direction: opts.direction,
            threshold: opts.threshold,
            period: Number(opts.period),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("ema-cross <pair>")
    .description(
      "EMA Crossover — triggers when fast EMA crosses above or below slow EMA",
    )
    .option("--direction <dir>", "bullish or bearish", "bullish")
    .option("--fast-period <n>", "Fast EMA period", "9")
    .option("--slow-period <n>", "Slow EMA period", "21")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
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
          {
            direction: opts.direction,
            fast_period: Number(opts.fastPeriod),
            slow_period: Number(opts.slowPeriod),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("macd <pair>")
    .description("MACD Crossover — triggers when MACD line crosses signal line")
    .option("--direction <dir>", "bullish or bearish", "bullish")
    .option("--fast <n>", "Fast EMA period", "12")
    .option("--slow <n>", "Slow EMA period", "26")
    .option("--signal <n>", "Signal line period", "9")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
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
          {
            direction: opts.direction,
            fast: Number(opts.fast),
            slow: Number(opts.slow),
            signal: Number(opts.signal),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("bollinger <pair>")
    .description(
      "Bollinger Bands — triggers when price touches or crosses upper/lower band",
    )
    .option("--band <band>", "upper or lower", "upper")
    .option("--period <n>", "Bollinger period", "20")
    .option("--std-mult <n>", "Standard deviation multiplier", "2")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
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
          {
            band: opts.band,
            period: Number(opts.period),
            std_mult: Number(opts.stdMult),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("volume-spike <pair>")
    .description(
      "Volume Spike — triggers when volume exceeds a multiple of the average",
    )
    .option("--period <n>", "Average volume period", "20")
    .option("--multiplier <n>", "Volume multiplier threshold", "2.0")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
    .action(
      async (
        pair: string,
        opts: { period: string; multiplier: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "volume_spike",
          {
            period: Number(opts.period),
            multiplier: Number(opts.multiplier),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("spread <pair>")
    .description(
      "Bid-Ask Spread — triggers when spread percentage crosses a threshold",
    )
    .option("--direction <dir>", "above or below", "above")
    .option("--threshold <value>", "Spread threshold in % (0.5 = 0.5%)", "0.5")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "spread",
          {
            direction: opts.direction,
            threshold: opts.threshold,
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("obi <pair>")
    .description(
      "Order Book Imbalance — triggers when buy/sell imbalance crosses a threshold",
    )
    .option("--direction <dir>", "above or below", "above")
    .option(
      "--threshold <value>",
      "Imbalance ratio (-1.0 to 1.0, 0.3 = 30%)",
      "0.3",
    )
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
    .action(
      async (
        pair: string,
        opts: { direction: string; threshold: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "obi",
          {
            direction: opts.direction,
            threshold: opts.threshold,
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("price-change <pair>")
    .description(
      "Price Change % — triggers when price rises or falls by X% over N hours",
    )
    .option("--direction <dir>", "rise or fall", "rise")
    .option("--threshold <value>", "Min % change (5 = 5%)", "5.0")
    .option("--lookback <n>", "Lookback in 1-hour candles", "24")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
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
          {
            direction: opts.direction,
            threshold: opts.threshold,
            lookback: Number(opts.lookback),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("atr-breakout <pair>")
    .description(
      "ATR Breakout — triggers when price moves more than a multiple of ATR",
    )
    .option("--period <n>", "ATR period", "14")
    .option("--multiplier <n>", "ATR multiplier", "1.5")
    .option("--interval <sec>", "Check interval in seconds (min 5)", "10")
    .action(
      async (
        pair: string,
        opts: { period: string; multiplier: string; interval: string },
      ) => {
        await startMonitor(
          pair,
          "atr_breakout",
          {
            period: Number(opts.period),
            multiplier: Number(opts.multiplier),
          },
          opts.interval,
        );
      },
    );

  monitor
    .command("types")
    .description("List supported monitor types")
    .action(() => {
      const rule = "\u2500".repeat(50);
      console.log(`\n  ${chalk.bold("Supported Monitor Types")}`);
      console.log(`  ${chalk.dim(rule)}\n`);
      for (const doc of TYPE_DOCS) {
        const label = TYPE_LABELS[doc.alertType] ?? doc.alertType;
        const padded = doc.command.padEnd(24);
        console.log(
          `  ${chalk.cyan.bold("\u25C6 " + padded)}${chalk.dim(label)}`,
        );
        console.log(`    ${doc.description}`);
        console.log(`    ${chalk.dim("Flags:")}   ${doc.flags}`);
        console.log(`    ${chalk.dim("Example:")} ${doc.example}`);
        console.log();
      }
      console.log(
        `  ${chalk.dim(rule)} ${chalk.dim(`${TYPE_DOCS.length} types available`)}`,
      );
    });
}
