import { Command } from "commander";
import { Decimal } from "decimal.js";
import chalk from "chalk";
import type { Candle } from "revolutx-api";
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
import { loadConnections } from "../db/store.js";

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
    console.error(`Invalid pair format '${pair}'. Expected e.g. 'BTC-USD'.`);
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
    if (d.isNeg() || (d.isZero() && !allowZero)) {
      console.error(
        `${name} must be ${allowZero ? "non-negative" : "positive"}, got '${value}'.`,
      );
      process.exit(1);
    }
    return d;
  } catch {
    console.error(`${name} must be a valid number, got '${value}'.`);
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

  const gridLevels = parseInt(opts.levels, 10);
  if (isNaN(gridLevels) || gridLevels < 3 || gridLevels > 50) {
    console.error("--levels must be between 3 and 50.");
    process.exit(1);
  }

  if (!VALID_RESOLUTIONS.has(opts.interval)) {
    console.error(
      `Invalid resolution '${opts.interval}'. Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
    );
    process.exit(1);
  }

  const rangePct = parseDecimalArg(opts.range, "--range").div(100);
  const investment = parseDecimalArg(opts.investment, "--investment");
  const days = parseInt(opts.days, 10) || 30;

  console.log(
    chalk.dim(
      `  Fetching ${opts.interval} candles for ${pair} (last ${days} days)...`,
    ),
  );
  const candles = await fetchCandles(pair, opts.interval, days);

  if (candles.length === 0) {
    console.error(`No candle data found for ${pair} (${opts.interval}).`);
    process.exit(1);
  }

  console.log(
    chalk.dim(`  Running backtest on ${candles.length} candles...\n`),
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
      gridLevels,
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
  console.log(`\u2554${h.repeat(w)}\u2557`);
  console.log(
    `\u2551${chalk.bold("  GRID BACKTEST RESULTS")}${" ".repeat(w - 23)}\u2551`,
  );
  console.log(`\u2560${h.repeat(w)}\u2563`);
  console.log(`\u2551${" ".repeat(w)}\u2551`);

  const pad = (label: string, value: string) => {
    const content = `   ${chalk.dim(label.padEnd(16))}${value}`;
    const visible = label.length + value.length + 19;
    const right = Math.max(0, w - visible + 16);
    return `\u2551${content}${" ".repeat(right)}\u2551`;
  };

  console.log(pad("Pair", pair));
  console.log(pad("Candles", `${candles.length} (${opts.interval})`));
  console.log(pad("Start Price", `$${startPrice.toFixed(2)}`));
  console.log(
    pad(
      "Grid Range",
      `$${lower.toFixed(2)} \u2014 $${upper.toFixed(2)} (\u00B1${rangePct.times(100).toFixed(1)}%)`,
    ),
  );
  console.log(pad("Levels", `${gridLevels} (${buyLevels} buy)`));
  console.log(pad(`${quote} / Level`, `$${quotePerLevel}`));
  console.log(`\u2551${" ".repeat(w)}\u2551`);
  console.log(`\u2560${h.repeat(w)}\u2563`);
  console.log(
    `\u2551${chalk.bold("  PERFORMANCE")}${" ".repeat(w - 13)}\u2551`,
  );
  console.log(`\u2560${h.repeat(w)}\u2563`);
  console.log(`\u2551${" ".repeat(w)}\u2551`);
  console.log(
    pad(
      "Total Trades",
      `${result.totalTrades} (${result.totalBuys} buys, ${result.totalSells} sells)`,
    ),
  );
  console.log(pad("Realized P&L", `$${result.realizedPnl.toFixed(2)}`));
  console.log(pad(`Final ${quote}`, `$${result.finalQuote.toFixed(2)}`));
  console.log(
    pad(
      `Final ${base}`,
      `${result.finalBase.toFixed(5)} (~$${baseValue.toFixed(2)})`,
    ),
  );
  console.log(pad("Total Value", `$${totalValue.toFixed(2)}`));

  const returnColor = netReturn.gte(0) ? chalk.green : chalk.red;
  console.log(
    pad(
      "Net Return",
      returnColor(`$${netReturn.toFixed(2)} (${returnPct.toFixed(2)}%)`),
    ),
  );
  console.log(
    pad("Max Drawdown", `${result.maxDrawdown.times(100).toFixed(2)}%`),
  );
  const annualizedPct =
    (Math.pow(1 + returnPct.toNumber() / 100, 365 / days) - 1) * 100;
  const annColor = annualizedPct >= 0 ? chalk.green : chalk.red;
  console.log(pad("Annualized", annColor(`${annualizedPct.toFixed(2)}%`)));
  console.log(`\u2551${" ".repeat(w)}\u2551`);

  if (result.tradeLog.length > 0) {
    console.log(`\u2560${h.repeat(w)}\u2563`);
    console.log(
      `\u2551${chalk.bold("  LAST TRADES")}${" ".repeat(w - 13)}\u2551`,
    );
    console.log(`\u2560${h.repeat(w)}\u2563`);
    const lastN = result.tradeLog.slice(-10);
    for (const trade of lastN) {
      const content = `   ${chalk.dim(trade)}`;
      // eslint-disable-next-line no-control-regex
      const visible = content.replace(/\x1B\[[0-9;]*m/g, "").length;
      const right = Math.max(0, w - visible);
      console.log(`\u2551${content}${" ".repeat(right)}\u2551`);
    }
    console.log(`\u2551${" ".repeat(w)}\u2551`);
  }

  console.log(`\u255A${h.repeat(w)}\u255D`);
  console.log(
    chalk.dim(
      "\n  Note: Backtest does not model spread/slippage or post_only rejections.\n" +
        "  Live performance will differ, especially in illiquid or fast-moving markets.",
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
    console.error(
      `Invalid resolution '${opts.interval}'. Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
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
        if (isNaN(n) || n < 3 || n > 50) throw new Error();
        return n;
      });
  } catch {
    console.error(
      "--levels must be comma-separated integers between 3 and 50.",
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
    console.error("--ranges must be comma-separated numbers, e.g. '3,5,10'.");
    process.exit(1);
  }

  const totalCombos = levelsList.length * rangesList.length;
  if (totalCombos > 200) {
    console.error(
      `Too many combinations (${totalCombos}). Max 200. Reduce --levels or --ranges.`,
    );
    process.exit(1);
  }

  console.log(
    chalk.dim(
      `  Fetching ${opts.interval} candles for ${pair} (last ${days} days)...`,
    ),
  );
  const candles = await fetchCandles(pair, opts.interval, days);

  if (candles.length === 0) {
    console.error(`No candle data found for ${pair} (${opts.interval}).`);
    process.exit(1);
  }

  console.log(
    chalk.dim(
      `  Testing ${totalCombos} parameter combinations on ${candles.length} candles...\n`,
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
          gridLevels: r.gridLevels,
          rangePct: r.rangePct.times(100).toNumber(),
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

  console.log(chalk.bold(`  Grid Optimization Results for ${pair}`));
  console.log(
    chalk.dim(
      `  ${candles.length} candles (${opts.interval}) | ${totalCombos} combinations tested\n`,
    ),
  );

  printTable(
    show.map((r, i) => ({
      rank: i + 1,
      levels: r.gridLevels,
      range: `${r.rangePct.times(100).toFixed(1)}%`,
      return_: `$${r.totalReturn.toFixed(2)}`,
      returnPct: `${r.returnPct.toFixed(2)}%`,
      trades: r.totalTrades,
      drawdown: `${r.maxDrawdown.times(100).toFixed(2)}%`,
      perTrade: `$${r.profitPerTrade.toFixed(2)}`,
    })),
    [
      { header: "#", accessor: (r) => String(r.rank), align: "right" },
      { header: "Levels", accessor: (r) => String(r.levels), align: "right" },
      { header: "Range", key: "range", align: "right" },
      { header: "Return", key: "return_", align: "right" },
      { header: "Return%", key: "returnPct", align: "right" },
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
        "Best Return",
        `${bestReturn.gridLevels} levels, ${bestReturn.rangePct.times(100).toFixed(1)}% range -> $${bestReturn.totalReturn.toFixed(2)}`,
      ],
      [
        "Best Risk-Adj",
        `${bestCalmar.gridLevels} levels, ${bestCalmar.rangePct.times(100).toFixed(1)}% range -> Calmar ${bestCalmar.calmarApprox.toFixed(2)}`,
      ],
      [
        "Lowest Drawdown",
        `${lowestDd.gridLevels} levels, ${lowestDd.rangePct.times(100).toFixed(1)}% range -> ${lowestDd.maxDrawdown.times(100).toFixed(2)}%`,
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
  },
): Promise<void> {
  pair = validatePair(pair);

  const gridLevels = parseInt(opts.levels, 10);
  if (isNaN(gridLevels) || gridLevels < 3 || gridLevels > 50) {
    console.error("--levels must be between 3 and 50.");
    process.exit(1);
  }

  const rangePct = parseDecimalArg(opts.range, "--range").div(100);
  const investment = parseDecimalArg(opts.investment, "--investment");
  const intervalSec = Math.max(5, parseInt(opts.interval, 10) || 30);

  const connections = loadConnections().filter((c) => c.enabled);
  if (connections.length === 0) {
    console.log(
      chalk.yellow(
        "  Telegram: None (add with: revx connector telegram add --token <token> --chat-id <id>)",
      ),
    );
  } else {
    console.log(
      chalk.dim(
        `  Telegram: ${connections.length} connection${connections.length !== 1 ? "s" : ""}`,
      ),
    );
  }

  const config: GridBotConfig = {
    pair,
    levels: gridLevels,
    rangePct: rangePct.toString(),
    investment: investment.toString(),
    splitInvestment: opts.split === true,
    intervalSec,
    dryRun: opts.dryRun === true,
  };

  const bot = new ForegroundGridBot(config);

  const shutdown = async () => {
    console.log(chalk.dim("\n  Shutting down grid bot..."));
    bot.stop();
    await bot.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await bot.run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function registerStrategyCommand(program: Command): void {
  const strategy = program
    .command("strategy")
    .description("Automated trading strategies")
    .addHelpText(
      "after",
      `
Examples:
  $ revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000 --days 30
  $ revx strategy grid optimize BTC-USD --investment 1000 --days 30 --interval 1h
  $ revx strategy grid run BTC-USD --levels 10 --range 5 --investment 500 --interval 30
  $ revx strategy grid run BTC-USD --levels 5 --range 2 --investment 100 --dry-run`,
    );

  const grid = strategy
    .command("grid")
    .description(
      "Grid trading strategy — places buy/sell orders at geometrically spaced price levels",
    );

  grid
    .command("backtest <pair>")
    .description("Run a grid backtest on historical candle data")
    .option("--levels <n>", "Number of grid levels", "10")
    .option("--range <pct>", "Grid range as percentage, e.g. 10 for ±10%", "10")
    .option("--investment <amount>", "Capital in quote currency", "1000")
    .option("--days <n>", "Days of historical data", "30")
    .option(
      "--interval <res>",
      "Candle resolution (1m, 5m, 15m, 30m, 1h, 4h, 1d)",
      "1h",
    )
    .option("--json", "Output as JSON")
    .option("-o, --output <format>", "Output format (json)")
    .action(handleBacktest);

  grid
    .command("optimize <pair>")
    .description("Test multiple grid parameter combinations and rank by return")
    .option("--investment <amount>", "Capital in quote currency", "1000")
    .option("--days <n>", "Days of historical data", "30")
    .option("--interval <res>", "Candle resolution", "1h")
    .option(
      "--levels <csv>",
      "Comma-separated grid level counts to test",
      "5,8,10,12,15,20,25,30",
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
    .option("--levels <n>", "Number of grid levels", "10")
    .option("--range <pct>", "Grid range as percentage, e.g. 5 for ±5%", "5")
    .option("--split", "Market-buy 50% of investment at start")
    .option("--interval <sec>", "Polling interval in seconds", "10")
    .option("--dry-run", "Simulate without placing real orders")
    .action(handleRun);
}
