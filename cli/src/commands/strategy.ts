import { Command } from "commander";
import { Decimal } from "decimal.js";
import chalk from "chalk";
import type { Candle } from "api-k9x2a";
import { getClient } from "../util/client.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
} from "../output/formatter.js";
import {
  runBacktest,
  optimizeGridParams,
  createGrid,
} from "../shared/backtest/index.js";
import { ForegroundGridBot, type GridBotConfig } from "../engine/grid-bot.js";
import { getCurrSymbol } from "../engine/grid-renderer.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

const VALID_RESOLUTIONS = new Set([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "2d",
  "4d",
  "1w",
  "2w",
  "4w",
]);

interface ParsedCandle extends Record<string, Decimal> {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
}

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(50)));
}

function printError(msg: string): void {
  console.error(`${chalk.red.bold("✖ Error:")} ${chalk.white(msg)}`);
}

function parseCandles(candles: Candle[]): ParsedCandle[] {
  const parsed: Array<{ ts: number; candle: ParsedCandle }> = [];
  for (const c of candles) {
    try {
      parsed.push({
        ts: c.start,
        candle: {
          open: new Decimal(c.open),
          high: new Decimal(c.high),
          low: new Decimal(c.low),
          close: new Decimal(c.close),
        },
      });
    } catch {
      continue;
    }
  }
  parsed.sort((a, b) => a.ts - b.ts);
  return parsed.map((p) => p.candle);
}

function validatePair(pair: string): string {
  pair = pair.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(pair)) {
    printError(
      `Invalid pair format '${chalk.cyan(pair)}'. Expected e.g. 'BTC-USD'.`,
    );
    process.exit(1);
  }
  return pair;
}

function parseDecimalArg(
  value: string,
  name: string,
  allowZero = false,
): Decimal {
  try {
    const d = new Decimal(value);
    // FIXED: Changed `d.isNeg()` to `d.isNegative()`
    if (d.isNegative() || (d.isZero() && !allowZero)) {
      printError(
        `${name} must be ${allowZero ? "non-negative" : "positive"}, got '${chalk.cyan(value)}'.`,
      );
      process.exit(1);
    }
    return d;
  } catch {
    printError(`${name} must be a valid number, got '${chalk.cyan(value)}'.`);
    process.exit(1);
  }
}

async function fetchCandles(
  pair: string,
  resolution: string,
  days: number,
): Promise<ParsedCandle[]> {
  const client = getClient({ requireAuth: true });
  const startDate = Date.now() - days * 24 * 60 * 60 * 1000;
  const resp = await client.getCandles(pair, {
    interval: resolution,
    startDate,
  });
  return parseCandles(resp.data);
}

async function handleBacktest(
  pair: string,
  opts: {
    levels: string;
    range: string;
    investment: string;
    days: string;
    interval: string;
    json?: boolean;
    output?: string;
  },
): Promise<void> {
  pair = validatePair(pair);

  const levelsPerSide = parseInt(opts.levels, 10);
  if (isNaN(levelsPerSide) || levelsPerSide < 2 || levelsPerSide > 25) {
    printError("--levels must be between 2 and 25 (per side).");
    process.exit(1);
  }
  const gridLevels = levelsPerSide * 2;

  if (!VALID_RESOLUTIONS.has(opts.interval)) {
    printError(
      `Invalid resolution '${chalk.cyan(opts.interval)}'. Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
    );
    process.exit(1);
  }

  const rangePct = parseDecimalArg(opts.range, "--range").div(100);
  const investment = parseDecimalArg(opts.investment, "--investment");
  const days = parseInt(opts.days, 10) || 30;

  console.log(
    chalk.gray(
      `\n  ↳ Fetching ${opts.interval} candles for ${chalk.white(pair)} (last ${days} days)...`,
    ),
  );
  const candles = await fetchCandles(pair, opts.interval, days);

  if (candles.length === 0) {
    printError(
      `No candle data found for ${chalk.cyan(pair)} (${opts.interval}).`,
    );
    process.exit(1);
  }

  console.log(
    chalk.gray(`  ↳ Running backtest on ${candles.length} candles...\n`),
  );
  const result = runBacktest(candles, gridLevels, rangePct, investment);

  if (isJsonOutput(opts)) {
    const finalPrice = candles[candles.length - 1].close;
    const baseVal = result.finalBase.times(finalPrice);
    const totalVal = result.finalQuote.plus(baseVal);
    const netRet = totalVal.minus(investment);
    const retPct = investment.isZero()
      ? 0
      : netRet.div(investment).times(100).toNumber();
    const annualized = (Math.pow(1 + retPct / 100, 365 / days) - 1) * 100;
    printJson({
      pair,
      gridLevels: gridLevels / 2,
      rangePct: rangePct.times(100).toNumber(),
      investment: investment.toNumber(),
      candles: candles.length,
      resolution: opts.interval,
      totalTrades: result.totalTrades,
      totalBuys: result.totalBuys,
      totalSells: result.totalSells,
      realizedPnl: result.realizedPnl.toNumber(),
      finalBase: result.finalBase.toNumber(),
      finalQuote: result.finalQuote.toNumber(),
      maxDrawdown: result.maxDrawdown.times(100).toNumber(),
      returnPct: retPct,
      annualizedReturnPct: parseFloat(annualized.toFixed(2)),
    });
    return;
  }

  const startPrice = candles[0].open;
  const finalPrice = candles[candles.length - 1].close;
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const baseValue = result.finalBase.times(finalPrice);
  const totalValue = result.finalQuote.plus(baseValue);
  const netReturn = totalValue.minus(investment);
  const returnPct = investment.isZero()
    ? new Decimal(0)
    : netReturn.div(investment).times(100);

  const levels = createGrid(startPrice, gridLevels, rangePct);
  const buyLevels = levels.filter((lv) => lv.hasBuyOrder).length;
  const [base, quote] = pair.split("-");
  const quotePerLevel = investment
    .div(Math.max(buyLevels, 1))
    .toDecimalPlaces(2);

  const w = 56;
  const h = "\u2550";
  const dimV = chalk.dim("\u2551");

  console.log(chalk.dim(`\u2554${h.repeat(w)}\u2557`));
  console.log(
    `${dimV}${chalk.bold.cyan("  GRID BACKTEST RESULTS")}${" ".repeat(w - 23)}${dimV}`,
  );
  console.log(chalk.dim(`\u2560${h.repeat(w)}\u2563`));
  console.log(`${dimV}${" ".repeat(w)}${dimV}`);

  const pad = (label: string, value: string) => {
    const content = `   ${chalk.gray(label.padEnd(16))}${value}`;
    // eslint-disable-next-line no-control-regex
    const visible = content.replace(/\u001B\[[0-9;]*m/g, "").length;
    const right = Math.max(0, w - visible);
    return `${dimV}${content}${" ".repeat(right)}${dimV}`;
  };

  const cs = getCurrSymbol(pair);
  console.log(pad("Pair", chalk.white(pair)));
  console.log(pad("Candles", `${candles.length} (${opts.interval})`));
  console.log(pad("Start Price", `${cs}${startPrice.toFixed(2)}`));
  console.log(
    pad(
      "Grid Range",
      `${cs}${lower.toFixed(2)} \u2014 ${cs}${upper.toFixed(2)} (${chalk.yellow(`\u00B1${rangePct.times(100).toFixed(1)}%`)})`,
    ),
  );
  console.log(
    pad(
      "Levels",
      `${gridLevels / 2} per side (${chalk.green(`${buyLevels} buy`)}, ${chalk.red(`${gridLevels - buyLevels} sell`)})`,
    ),
  );
  console.log(pad(`${quote} / Level`, `${cs}${quotePerLevel}`));
  const ratio = upper.div(lower).pow(new Decimal(1).div(gridLevels - 1));
  const profitPct = ratio.minus(1).times(100);
  const profitDollar = quotePerLevel.times(ratio.minus(1));
  console.log(
    pad(
      "Profit/Grid",
      `${chalk.green(`${cs}${profitDollar.toFixed(2)}`)} (${profitPct.toFixed(2)}%)`,
    ),
  );
  console.log(`${dimV}${" ".repeat(w)}${dimV}`);
  console.log(chalk.dim(`\u2560${h.repeat(w)}\u2563`));
  console.log(
    `${dimV}${chalk.bold.cyan("  PERFORMANCE")}${" ".repeat(w - 13)}${dimV}`,
  );
  console.log(chalk.dim(`\u2560${h.repeat(w)}\u2563`));
  console.log(`${dimV}${" ".repeat(w)}${dimV}`);
  console.log(
    pad(
      "Total Trades",
      `${result.totalTrades} (${chalk.green(`${result.totalBuys} buys`)}, ${chalk.red(`${result.totalSells} sells`)})`,
    ),
  );

  const pnlColor = result.realizedPnl.gte(0) ? chalk.green : chalk.red;
  console.log(
    pad("Realized P&L", pnlColor(`${cs}${result.realizedPnl.toFixed(2)}`)),
  );
  console.log(pad(`Final ${quote}`, `${cs}${result.finalQuote.toFixed(2)}`));
  console.log(
    pad(
      `Final ${base}`,
      `${result.finalBase.toFixed(5)} (~${cs}${baseValue.toFixed(2)})`,
    ),
  );
  console.log(pad("Portfolio Value", `${cs}${totalValue.toFixed(2)}`));

  const returnColor = netReturn.gte(0) ? chalk.green : chalk.red;
  console.log(pad("Total P&L", returnColor(`${cs}${netReturn.toFixed(2)}`)));
  console.log(pad("ROI", returnColor(`${returnPct.toFixed(2)}%`)));
  console.log(
    pad(
      "Max Drawdown",
      chalk.red(`${result.maxDrawdown.times(100).toFixed(2)}%`),
    ),
  );
  const annualizedPct =
    (Math.pow(1 + returnPct.toNumber() / 100, 365 / days) - 1) * 100;
  const annColor = annualizedPct >= 0 ? chalk.green : chalk.red;
  console.log(pad("Annualized", annColor(`${annualizedPct.toFixed(2)}%`)));
  console.log(`${dimV}${" ".repeat(w)}${dimV}`);

  if (result.tradeLog.length > 0) {
    console.log(chalk.dim(`\u2560${h.repeat(w)}\u2563`));
    console.log(
      `${dimV}${chalk.bold.cyan("  LAST TRADES")}${" ".repeat(w - 13)}${dimV}`,
    );
    console.log(chalk.dim(`\u2560${h.repeat(w)}\u2563`));
    const lastN = result.tradeLog.slice(-10);
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*m/g, "");
    const padRow = (content: string) => {
      const vis = stripAnsi(content).length;
      const right = Math.max(0, w - vis);
      return `${dimV}${content}${" ".repeat(right)}${dimV}`;
    };
    const indent = "      ";
    const maxFieldWidth = w - indent.length;
    for (const trade of lastN) {
      let splitIdx = trade.indexOf(" | profit=");
      if (splitIdx === -1) splitIdx = trade.indexOf(" | realized=");
      if (splitIdx !== -1) {
        console.log(padRow(`   ${chalk.gray(trade.slice(0, splitIdx))}`));
        const fields = trade.slice(splitIdx + 3).split(" | ");
        let line = "";
        for (const field of fields) {
          const next = line ? `${line} | ${field}` : field;
          if (next.length > maxFieldWidth && line) {
            console.log(padRow(`${indent}${chalk.gray(line)}`));
            line = field;
          } else {
            line = next;
          }
        }
        if (line) console.log(padRow(`${indent}${chalk.gray(line)}`));
      } else {
        console.log(padRow(`   ${chalk.gray(trade)}`));
      }
    }
    console.log(`${dimV}${" ".repeat(w)}${dimV}`);
  }

  console.log(chalk.dim(`\u255A${h.repeat(w)}\u255D`));
  console.log(
    chalk.gray(
      "\n  ↳ Note: Backtest does not model spread/slippage or post_only rejections.\n" +
        "    Live performance will differ, especially in illiquid or fast-moving markets.",
    ),
  );
}

async function handleOptimize(
  pair: string,
  opts: {
    investment: string;
    days: string;
    interval: string;
    levels: string;
    ranges: string;
    top: string;
    json?: boolean;
    output?: string;
  },
): Promise<void> {
  pair = validatePair(pair);

  if (!VALID_RESOLUTIONS.has(opts.interval)) {
    printError(
      `Invalid resolution '${chalk.cyan(opts.interval)}'. Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
    );
    process.exit(1);
  }

  const investment = parseDecimalArg(opts.investment, "--investment");
  const days = parseInt(opts.days, 10) || 30;
  const topN = Math.max(1, Math.min(parseInt(opts.top, 10) || 10, 50));

  let levelsList: number[];
  try {
    levelsList = opts.levels
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x)
      .map((x) => {
        const n = parseInt(x, 10);
        if (isNaN(n) || n < 2 || n > 25) throw new Error();
        return n * 2;
      });
  } catch {
    printError(
      "--levels must be comma-separated integers between 2 and 25 (per side).",
    );
    process.exit(1);
  }

  let rangesList: Decimal[];
  try {
    rangesList = opts.ranges
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x)
      .map((x) => new Decimal(x).div(100));
  } catch {
    printError("--ranges must be comma-separated numbers, e.g. '3,5,10'.");
    process.exit(1);
  }

  const totalCombos = levelsList.length * rangesList.length;
  if (totalCombos > 200) {
    printError(
      `Too many combinations (${chalk.cyan(totalCombos)}). Max 200. Reduce --levels or --ranges.`,
    );
    process.exit(1);
  }

  console.log(
    chalk.gray(
      `\n  ↳ Fetching ${opts.interval} candles for ${chalk.white(pair)} (last ${days} days)...`,
    ),
  );
  const candles = await fetchCandles(pair, opts.interval, days);

  if (candles.length === 0) {
    printError(
      `No candle data found for ${chalk.cyan(pair)} (${opts.interval}).`,
    );
    process.exit(1);
  }

  console.log(
    chalk.gray(
      `  ↳ Testing ${totalCombos} parameter combinations on ${candles.length} candles...\n`,
    ),
  );
  const results = optimizeGridParams(
    candles,
    levelsList,
    rangesList,
    investment,
    days,
  );

  if (isJsonOutput(opts)) {
    printJson(
      results.slice(0, topN).map((r) => {
        const annualized =
          (Math.pow(1 + r.returnPct.toNumber() / 100, 365 / days) - 1) * 100;
        return {
          rank: results.indexOf(r) + 1,
          gridLevels: r.gridLevels / 2,
          rangePct: r.rangePct.times(100).toNumber(),
          realizedPnl: r.realizedPnl.toNumber(),
          totalReturn: r.totalReturn.toNumber(),
          returnPct: r.returnPct.toNumber(),
          annualizedReturnPct: parseFloat(annualized.toFixed(2)),
          totalTrades: r.totalTrades,
          maxDrawdown: r.maxDrawdown.times(100).toNumber(),
          profitPerTrade: r.profitPerTrade.toNumber(),
          calmarApprox: r.calmarApprox.toNumber(),
        };
      }),
    );
    return;
  }

  const show = results.slice(0, topN);
  const cs = getCurrSymbol(pair);

  printSectionHeader(`Grid Optimization Results: ${pair}`);
  console.log(
    chalk.gray(
      `  ↳ ${candles.length} candles (${opts.interval}) | ${totalCombos} combinations tested\n`,
    ),
  );

  printTable(
    show.map((r, i) => {
      const isProfitable = r.totalReturn.gte(0);
      const isRealizedPos = r.realizedPnl.gte(0);
      return {
        rank: i + 1,
        levels: r.gridLevels / 2,
        range: `${r.rangePct.times(100).toFixed(1)}%`,
        realized: isRealizedPos
          ? chalk.green(`${cs}${r.realizedPnl.toFixed(2)}`)
          : chalk.red(`${cs}${r.realizedPnl.toFixed(2)}`),
        return_: isProfitable
          ? chalk.green(`${cs}${r.totalReturn.toFixed(2)}`)
          : chalk.red(`${cs}${r.totalReturn.toFixed(2)}`),
        returnPct: isProfitable
          ? chalk.green(`${r.returnPct.toFixed(2)}%`)
          : chalk.red(`${r.returnPct.toFixed(2)}%`),
        trades: r.totalTrades,
        drawdown: chalk.red(`${r.maxDrawdown.times(100).toFixed(2)}%`),
        perTrade: `${cs}${r.profitPerTrade.toFixed(2)}`,
      };
    }),
    [
      { header: "#", accessor: (r) => String(r.rank), align: "right" },
      { header: "Levels", accessor: (r) => String(r.levels), align: "right" },
      { header: "Range", key: "range", align: "right" },
      { header: "Realized", key: "realized", align: "right" },
      { header: "Total P&L", key: "return_", align: "right" },
      { header: "ROI", key: "returnPct", align: "right" },
      { header: "Trades", accessor: (r) => String(r.trades), align: "right" },
      { header: "Drawdown", key: "drawdown", align: "right" },
      { header: "$/Trade", key: "perTrade", align: "right" },
    ],
  );

  if (results.length > 0) {
    console.log("");
    const bestReturn = results[0];
    const bestCalmar = results.reduce((b, r) =>
      r.calmarApprox.gt(b.calmarApprox) ? r : b,
    );
    const lowestDd = results.reduce((b, r) =>
      r.maxDrawdown.lt(b.maxDrawdown) ? r : b,
    );

    printKeyValue([
      [
        "Best Total P&L",
        `${chalk.white(bestReturn.gridLevels / 2)} levels/side, ${chalk.white(bestReturn.rangePct.times(100).toFixed(1) + "%")} range \u2192 Realized: ${chalk.green(cs + bestReturn.realizedPnl.toFixed(2))} | Total: ${chalk.green(cs + bestReturn.totalReturn.toFixed(2))}`,
      ],
      [
        "Best Risk-Adj",
        `${chalk.white(bestCalmar.gridLevels / 2)} levels/side, ${chalk.white(bestCalmar.rangePct.times(100).toFixed(1) + "%")} range \u2192 ${chalk.cyan("Calmar " + bestCalmar.calmarApprox.toFixed(2))}`,
      ],
      [
        "Lowest Drawdown",
        `${chalk.white(lowestDd.gridLevels / 2)} levels/side, ${chalk.white(lowestDd.rangePct.times(100).toFixed(1) + "%")} range \u2192 ${chalk.green(lowestDd.maxDrawdown.times(100).toFixed(2) + "%")}`,
      ],
    ]);
  }
}

async function handleRun(
  pair: string,
  opts: {
    levels: string;
    range: string;
    investment: string;
    split?: boolean;
    interval: string;
    dryRun?: boolean;
    reset?: boolean;
  },
): Promise<void> {
  pair = validatePair(pair);

  const levelsPerSide = parseInt(opts.levels, 10);
  if (isNaN(levelsPerSide) || levelsPerSide < 2 || levelsPerSide > 25) {
    printError("--levels must be between 2 and 25 (per side).");
    process.exit(1);
  }
  const gridLevels = levelsPerSide * 2;

  const rangePct = parseDecimalArg(opts.range, "--range").div(100);
  const investment = parseDecimalArg(opts.investment, "--investment");
  const intervalSec = Math.max(5, parseInt(opts.interval, 10) || 30);

  const config: GridBotConfig = {
    pair,
    levels: gridLevels,
    rangePct: rangePct.toString(),
    investment: investment.toString(),
    splitInvestment: opts.split === true,
    intervalSec,
    dryRun: opts.dryRun === true,
    reset: opts.reset === true,
  };

  const bot = new ForegroundGridBot(config);

  const shutdown = async () => {
    console.log(chalk.yellow("\n  ↳ Shutting down grid bot..."));
    bot.stop();
    await bot.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await bot.run();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function registerStrategyCommand(program: Command): void {
  const strategy = program
    .command("strategy")
    .description("Automated trading strategies")
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
  $ revx strategy grid backtest BTC-USD --levels 5 --range 10 --investment 1000 --days 30
  $ revx strategy grid optimize BTC-USD --investment 1000 --days 30 --interval 1h
  $ revx strategy grid run BTC-USD --levels 5 --range 5 --investment 500 --interval 30
  $ revx strategy grid run BTC-USD --levels 3 --range 2 --investment 100 --dry-run`,
    );

  const grid = strategy
    .command("grid")
    .description(
      "Grid trading strategy — places buy/sell orders at geometrically spaced price levels",
    );

  grid
    .command("backtest <pair>")
    .description("Run a grid backtest on historical candle data")
    .option(
      "--levels <n>",
      "Grid levels per side (total orders = 2×levels)",
      "5",
    )
    .option("--range <pct>", "Grid range as percentage, e.g. 10 for ±10%", "10")
    .option("--investment <amount>", "Capital in quote currency", "1000")
    .option("--days <n>", "Days of historical data", "3")
    .option(
      "--interval <res>",
      "Candle resolution (1m, 5m, 15m, 30m, 1h, 4h, 1d)",
      "1m",
    )
    .option("--json", "Output as JSON")
    .option("-o, --output <format>", "Output format (json)")
    .action(handleBacktest);

  grid
    .command("optimize <pair>")
    .description("Test multiple grid parameter combinations and rank by return")
    .option("--investment <amount>", "Capital in quote currency", "1000")
    .option("--days <n>", "Days of historical data", "3")
    .option("--interval <res>", "Candle resolution", "1m")
    .option(
      "--levels <csv>",
      "Comma-separated grid levels per side to test",
      "3,5,8,10,15",
    )
    .option(
      "--ranges <csv>",
      "Comma-separated range percentages to test",
      "3,5,7,10,12,15,20",
    )
    .option("--top <n>", "Number of top results to show", "10")
    .option("--json", "Output as JSON")
    .option("-o, --output <format>", "Output format (json)")
    .action(handleOptimize);

  grid
    .command("run <pair>")
    .description("Run a live grid trading bot (foreground process)")
    .requiredOption(
      "--investment <amount>",
      "Capital in quote currency to deploy",
    )
    .option(
      "--levels <n>",
      "Grid levels per side (total orders = 2×levels)",
      "5",
    )
    .option("--range <pct>", "Grid range as percentage, e.g. 5 for ±5%", "5")
    .option("--split", "Market-buy base for sell levels at start")
    .option("--interval <sec>", "Polling interval in seconds", "10")
    .option("--dry-run", "Simulate without placing real orders")
    .option("--reset", "Discard saved state and start a fresh grid")
    .action(handleRun);
}
