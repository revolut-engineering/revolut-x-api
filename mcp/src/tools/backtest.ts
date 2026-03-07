import { Decimal } from "decimal.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Candle } from "revolutx-api";
import { textResult, validateSymbol, VALID_RESOLUTIONS } from "./_helpers.js";
import {
  createGrid,
  runBacktest,
  optimizeGridParams,
  type BacktestResult,
  type OptimizationResult,
} from "../shared/backtest/engine.js";

function parseDecimal(
  value: string,
  name: string,
  allowZero: boolean = false,
): [Decimal | null, string | null] {
  try {
    const d = new Decimal(value);
    if (d.isNeg() || (d.isZero() && !allowZero)) {
      return [
        null,
        `${name} must be ${allowZero ? "non-negative" : "positive"}, got '${value}'.`,
      ];
    }
    return [d, null];
  } catch {
    return [null, `${name} must be a valid number, got '${value}'.`];
  }
}

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

function formatBacktestResult(
  result: BacktestResult,
  symbol: string,
  candles: Array<Record<string, Decimal>>,
  resolution: string,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  feeRate: Decimal,
): string {
  const startPrice = candles[0].close;
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const finalPrice = candles[candles.length - 1].close;
  const btcValue = result.finalBtc.times(finalPrice);
  const totalValue = result.finalUsd.plus(btcValue);
  const netReturn = totalValue.minus(investment);
  const returnPct = investment.isZero()
    ? new Decimal(0)
    : netReturn.div(investment).times(100);

  const levels = createGrid(startPrice, gridLevels, rangePct);
  const buyLevels = levels.filter((lv) => lv.hasBuyOrder).length;
  const usdPerLevel = investment.div(Math.max(buyLevels, 1)).toDecimalPlaces(2);

  const priceLow = candles.reduce(
    (min, c) => Decimal.min(min, c.low),
    candles[0].low,
  );
  const priceHigh = candles.reduce(
    (max, c) => Decimal.max(max, c.high),
    candles[0].high,
  );

  const lines = [
    `Grid Backtest Results for ${symbol}`,
    "=".repeat(50),
    `Data: ${candles.length} candles (${resolution} resolution)`,
    `Price range: $${priceLow.toFixed(2)} - $${priceHigh.toFixed(2)}`,
    `Start price: $${startPrice.toFixed(2)}`,
    `Grid range: $${lower.toFixed(2)} - $${upper.toFixed(2)} (${rangePct.times(100).toNumber().toFixed(1)}%)`,
    `Grid levels: ${gridLevels} | Buy levels: ${buyLevels} | USD/level: $${usdPerLevel}`,
    `Fee rate: ${feeRate.times(100).toNumber().toFixed(2)}%`,
    "",
    "Performance",
    "-".repeat(50),
    `Total trades: ${result.totalTrades} (${result.totalBuys} buys, ${result.totalSells} sells)`,
    `Total fees: $${result.totalFees.toFixed(2)}`,
    `Realized P&L: $${result.realizedPnl.toFixed(2)}`,
    `Final USD: $${result.finalUsd.toFixed(2)}`,
    `Final BTC: ${result.finalBtc.toFixed(5)} (~$${btcValue.toFixed(2)})`,
    `Total portfolio: $${totalValue.toFixed(2)}`,
    `Net return: $${netReturn.toFixed(2)} (${returnPct.toNumber().toFixed(2)}%)`,
    `Max drawdown: ${result.maxDrawdown.times(100).toNumber().toFixed(2)}%`,
  ];

  if (result.tradeLog.length) {
    lines.push("");
    const lastN = result.tradeLog.slice(-10);
    lines.push(`Last ${lastN.length} trades:`);
    for (const trade of lastN) {
      lines.push(`  ${trade}`);
    }
  }

  return lines.join("\n");
}

function formatOptimizationResults(
  results: OptimizationResult[],
  symbol: string,
  candleCount: number,
  resolution: string,
  totalCombos: number,
  topN: number,
): string {
  if (!results.length) {
    return "No optimization results (no valid parameter combinations produced trades).";
  }

  const show = Math.min(topN, results.length);
  const lines = [
    `Grid Optimization Results for ${symbol}`,
    "=".repeat(90),
    `Data: ${candleCount} candles (${resolution} resolution)`,
    `Tested ${totalCombos} parameter combinations`,
    "",
    `Top ${show} by Total Return:`,
    `${"Rank".padEnd(5)} ${"Levels".padEnd(8)} ${"Range".padEnd(8)} ${"Return".padEnd(12)} ${"Return%".padEnd(10)} ${"Trades".padEnd(8)} ${"Drawdown".padEnd(10)} ${"$/Trade".padEnd(10)}`,
    "-".repeat(90),
  ];

  for (let i = 0; i < show; i++) {
    const r = results[i];
    lines.push(
      `${String(i + 1).padEnd(5)} ` +
        `${String(r.gridLevels).padEnd(8)} ` +
        `${r.rangePct.times(100).toNumber().toFixed(1)}%${"".padEnd(4)} ` +
        `$${r.totalReturn.toNumber().toFixed(2).padStart(9)} ` +
        `${r.returnPct.toNumber().toFixed(2).padStart(8)}% ` +
        `${String(r.totalTrades).padEnd(8)} ` +
        `${r.maxDrawdown.times(100).toNumber().toFixed(2).padStart(7)}% ` +
        `$${r.profitPerTrade.toNumber().toFixed(2).padStart(7)}`,
    );
  }

  lines.push("=".repeat(90));
  lines.push("");
  lines.push("Best by Metric:");
  lines.push("-".repeat(50));

  const bestReturn = results.reduce((best, r) =>
    r.totalReturn.gt(best.totalReturn) ? r : best,
  );
  lines.push(
    `  Highest Return:  ${bestReturn.gridLevels} levels, ` +
      `${bestReturn.rangePct.times(100).toNumber().toFixed(1)}% range -> $${bestReturn.totalReturn.toNumber().toFixed(2)}`,
  );

  const bestSharpe = results.reduce((best, r) =>
    r.sharpeApprox.gt(best.sharpeApprox) ? r : best,
  );
  lines.push(
    `  Best Risk-Adj:   ${bestSharpe.gridLevels} levels, ` +
      `${bestSharpe.rangePct.times(100).toNumber().toFixed(1)}% range -> Sharpe ${bestSharpe.sharpeApprox.toNumber().toFixed(2)}`,
  );

  const mostTrades = results.reduce((best, r) =>
    r.totalTrades > best.totalTrades ? r : best,
  );
  lines.push(
    `  Most Trades:     ${mostTrades.gridLevels} levels, ` +
      `${mostTrades.rangePct.times(100).toNumber().toFixed(1)}% range -> ${mostTrades.totalTrades} trades`,
  );

  const lowestDd = results.reduce((best, r) =>
    r.maxDrawdown.lt(best.maxDrawdown) ? r : best,
  );
  lines.push(
    `  Lowest Drawdown: ${lowestDd.gridLevels} levels, ` +
      `${lowestDd.rangePct.times(100).toNumber().toFixed(1)}% range -> ${lowestDd.maxDrawdown.times(100).toNumber().toFixed(2)}%`,
  );

  return lines.join("\n");
}

export function registerBacktestTools(server: McpServer): void {
  server.registerTool(
    "grid_backtest",
    {
      title: "Run Grid Backtest",
      description:
        "Run a grid trading backtest on historical candle data from Revolut X. Simulates a grid strategy: places buy orders at evenly-spaced price levels below the starting price, sells at the next level above. Uses up to ~100 most recent candles from the API.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        grid_levels: z
          .number()
          .default(10)
          .describe("Number of grid levels (default 10, range 3-50)"),
        range_pct: z
          .string()
          .default("10")
          .describe(
            'Grid range as percentage of starting price, e.g. "10" for ±10%',
          ),
        investment: z
          .string()
          .default("1000")
          .describe('Total USD investment (default "1000")'),
        resolution: z
          .string()
          .default("1h")
          .describe('Candle interval (default "1h")'),
        fee_rate: z
          .string()
          .default("0")
          .describe(
            'Trading fee as percentage, e.g. "0.1" for 0.1% (default "0")',
          ),
      },
      annotations: {
        title: "Run Grid Backtest",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      symbol,
      grid_levels,
      range_pct,
      investment,
      resolution,
      fee_rate,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      if (grid_levels < 3 || grid_levels > 50) {
        return textResult(
          `grid_levels must be between 3 and 50, got ${grid_levels}.`,
        );
      }

      if (!VALID_RESOLUTIONS.has(resolution)) {
        return textResult(
          `Invalid resolution '${resolution}'. ` +
            `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
        );
      }

      let [rangeDec, err] = parseDecimal(range_pct, "range_pct"); // eslint-disable-line prefer-const
      if (err) return textResult(err);
      rangeDec = rangeDec!.div(100);

      const [investDec, err2] = parseDecimal(investment, "investment");
      if (err2) return textResult(err2);

      let [feeDec, err3] = parseDecimal(fee_rate, "fee_rate", true); // eslint-disable-line prefer-const
      if (err3) return textResult(err3);
      feeDec = feeDec!.div(100);

      let candleResult;
      try {
        candleResult = await getRevolutXClient().getCandles(symbol, {
          interval: resolution,
        });
      } catch (e) {
        if (e instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw e;
      }

      const candles = parseCandles(candleResult.data);

      if (!candles.length) {
        return textResult(
          `No candle data found for ${symbol} (${resolution}).`,
        );
      }

      const result = runBacktest(
        candles,
        grid_levels,
        rangeDec,
        investDec!,
        feeDec,
      );

      return textResult(
        formatBacktestResult(
          result,
          symbol,
          candles,
          resolution,
          grid_levels,
          rangeDec,
          investDec!,
          feeDec,
        ),
      );
    },
  );

  server.registerTool(
    "grid_optimize",
    {
      title: "Optimize Grid Parameters",
      description:
        "Test multiple grid parameter combinations and return ranked results. Runs grid_backtest for every combination of grid_levels and range_pct, then ranks by total return.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD"'),
        investment: z
          .string()
          .default("1000")
          .describe('Total USD investment (default "1000")'),
        resolution: z
          .string()
          .default("1h")
          .describe('Candle interval (default "1h")'),
        fee_rate: z
          .string()
          .default("0")
          .describe('Trading fee as percentage (default "0")'),
        grid_levels_options: z
          .string()
          .default("5,8,10,12,15,20,25,30")
          .describe("Comma-separated grid level counts to test"),
        range_pct_options: z
          .string()
          .default("3,5,7,10,12,15,20")
          .describe("Comma-separated range percentages to test"),
        top_n: z
          .number()
          .default(10)
          .describe("Number of top results to show (default 10, max 50)"),
      },
      annotations: {
        title: "Optimize Grid Parameters",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      symbol,
      investment,
      resolution,
      fee_rate,
      grid_levels_options,
      range_pct_options,
      top_n,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      if (!VALID_RESOLUTIONS.has(resolution)) {
        return textResult(
          `Invalid resolution '${resolution}'. ` +
            `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
        );
      }

      const [investDec, err1] = parseDecimal(investment, "investment");
      if (err1) return textResult(err1);

      let [feeDec, err2] = parseDecimal(fee_rate, "fee_rate", true); // eslint-disable-line prefer-const
      if (err2) return textResult(err2);
      feeDec = feeDec!.div(100);

      let levelsList: number[];
      try {
        levelsList = grid_levels_options
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x)
          .map((x) => {
            const n = parseInt(x, 10);
            if (isNaN(n)) throw new Error();
            return n;
          });
      } catch {
        return textResult(
          "grid_levels_options must be comma-separated integers, e.g. '5,10,15'.",
        );
      }
      for (const lv of levelsList) {
        if (lv < 3 || lv > 50) {
          return textResult(
            `Each grid level must be between 3 and 50, got ${lv}.`,
          );
        }
      }

      let rangesList: Decimal[];
      try {
        rangesList = range_pct_options
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x)
          .map((x) => new Decimal(x).div(100));
      } catch {
        return textResult(
          "range_pct_options must be comma-separated numbers, e.g. '3,5,10'.",
        );
      }
      for (const rp of rangesList) {
        if (rp.lte(0)) {
          return textResult("Each range_pct must be positive.");
        }
      }

      const totalCombos = levelsList.length * rangesList.length;
      if (totalCombos > 200) {
        return textResult(
          `Too many combinations (${totalCombos}). ` +
            "Max 200. Reduce grid_levels_options or range_pct_options.",
        );
      }

      top_n = Math.max(1, Math.min(top_n, 50));

      let candleResult;
      try {
        candleResult = await getRevolutXClient().getCandles(symbol, {
          interval: resolution,
        });
      } catch (e) {
        if (e instanceof AuthNotConfiguredError) return textResult(SETUP_GUIDE);
        throw e;
      }

      const candles = parseCandles(candleResult.data);

      if (!candles.length) {
        return textResult(
          `No candle data found for ${symbol} (${resolution}).`,
        );
      }

      const results = optimizeGridParams(
        candles,
        levelsList,
        rangesList,
        investDec!,
        feeDec,
      );

      return textResult(
        formatOptimizationResults(
          results,
          symbol,
          candles.length,
          resolution,
          totalCombos,
          top_n,
        ),
      );
    },
  );
}
