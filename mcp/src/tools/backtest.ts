import { Decimal } from "decimal.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Candle } from "api-k9x2a";
import {
  textResult,
  validateSymbol,
  validateResolution,
  handleApiError,
} from "../shared/_helpers.js";
import {
  createGrid,
  runBacktest,
  optimizeGridParams,
  type BacktestResult,
  type OptimizationResult,
} from "../shared/backtest/index.js";
import { RESOLUTIONS_MAP } from "../shared/common.js";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "\u20AC",
  GBP: "\u00A3",
};

function getCurrSymbol(symbol: string): string {
  const quote = symbol.split("-")[1] ?? "";
  return CURRENCY_SYMBOLS[quote] ?? "";
}

function parseDecimal(
  value: string,
  name: string,
  allowZero = false,
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

async function fetchBacktestCandles(
  symbol: string,
  resolution: string,
  days: number,
  fetchCandles: (opts: {
    interval: string;
    startDate: number;
  }) => Promise<{ data: Candle[] }>,
  setupGuide: string,
): Promise<
  | { error: ReturnType<typeof textResult> }
  | { candles: ParsedCandle[]; actualDays: number; llmNotice: string }
> {
  const now = Date.now();
  let startDate = now - days * 24 * 60 * 60 * 1000;

  const intervalMs = RESOLUTIONS_MAP[resolution] || 60 * 60 * 1000;
  const expectedCandles = Math.ceil((now - startDate) / intervalMs);

  let actualDays = days;
  let llmNotice =
    "\n\n*** NOTE TO LLM: This is the complete batch for your request. There is no more data available. ***";

  if (expectedCandles > 50000) {
    startDate = now - 50000 * intervalMs;
    actualDays = Number(((now - startDate) / (24 * 60 * 60 * 1000)).toFixed(2));
    llmNotice =
      "\n\n*** NOTE TO LLM: The requested range contains more than 50,000 candles. Returning the last 50,000 candles from the current timestamp. This is all the data available. ***";
  }

  let candleResult;
  try {
    candleResult = await fetchCandles({ interval: resolution, startDate });
  } catch (error) {
    const handled = await handleApiError(error, setupGuide);
    if (handled) return { error: handled };
    throw error;
  }

  const candles = parseCandles(candleResult.data);

  if (!candles.length) {
    return {
      error: textResult(
        `No candle data found for ${symbol} (${resolution}). Try get more recent data`,
      ),
    };
  }

  return { candles, actualDays, llmNotice };
}

function formatBacktestResult(
  result: BacktestResult,
  symbol: string,
  candles: ParsedCandle[],
  resolution: string,
  gridLevels: number,
  rangePct: Decimal,
  investment: Decimal,
  days: number,
  split = false,
): string {
  const startPrice = candles[0].open;
  const lower = startPrice.times(new Decimal(1).minus(rangePct));
  const upper = startPrice.times(new Decimal(1).plus(rangePct));
  const finalPrice = candles[candles.length - 1].close;
  const baseValue = result.finalBase.times(finalPrice);
  const totalValue = result.finalQuote.plus(baseValue);
  const netReturn = totalValue.minus(investment);
  const returnPct = investment.isZero()
    ? new Decimal(0)
    : netReturn.div(investment).times(100);

  const levels = createGrid(startPrice, gridLevels, rangePct);
  const buyLevels = levels.filter((lv) => lv.hasBuyOrder).length;
  const sellLevels = split
    ? levels.filter((lv) => lv.price.gt(startPrice)).length
    : 0;
  const totalCapitalLevels = split ? buyLevels + sellLevels : buyLevels;
  const quotePerLevel = investment
    .div(Math.max(totalCapitalLevels, 1))
    .toDecimalPlaces(2);

  const [base, quote] = symbol.split("-");
  const cs = getCurrSymbol(symbol);

  const priceLow = candles.reduce(
    (min, c) => Decimal.min(min, c.low),
    candles[0].low,
  );
  const priceHigh = candles.reduce(
    (max, c) => Decimal.max(max, c.high),
    candles[0].high,
  );

  const rawReturn = returnPct.toNumber() / 100;
  const annualizedPct =
    rawReturn > -1 ? (Math.pow(1 + rawReturn, 365 / days) - 1) * 100 : -100;

  const lines = [
    `Grid Backtest Results for ${symbol}`,
    "=".repeat(50),
    `Data: ${candles.length} candles (${resolution} resolution, ${days} days)`,
    `Price range: ${cs}${priceLow.toFixed(2)} - ${cs}${priceHigh.toFixed(2)}`,
    `Start price: ${cs}${startPrice.toFixed(2)}`,
    `Grid range: ${cs}${lower.toFixed(2)} - ${cs}${upper.toFixed(2)} (±${rangePct.times(100).toFixed(1)}%)`,
    `Grid levels: ${gridLevels / 2} per side (${buyLevels} buy, ${gridLevels - buyLevels} sell) | ${quote}/level: ${cs}${quotePerLevel}`,
    (() => {
      const ratio = upper.div(lower).pow(new Decimal(1).div(gridLevels - 1));
      const profitPct = ratio.minus(1).times(100);
      const profitDollar = quotePerLevel.times(ratio.minus(1));
      return `Profit/grid: ${cs}${profitDollar.toFixed(2)} (${profitPct.toFixed(2)}%)`;
    })(),
    "",
    "Performance",
    "-".repeat(50),
    `Total trades: ${result.totalTrades} (${result.totalBuys} buys, ${result.totalSells} sells)`,
    `Realized P&L: ${cs}${result.realizedPnl.toFixed(2)}`,
    `Final ${quote}: ${cs}${result.finalQuote.toFixed(2)}`,
    `Final ${base}: ${result.finalBase.toFixed(5)} (~${cs}${baseValue.toFixed(2)})`,
    `Portfolio Value: ${cs}${totalValue.toFixed(2)}`,
    `Total P&L: ${cs}${netReturn.toFixed(2)}`,
    `ROI: ${returnPct.toFixed(2)}%`,
    `Max drawdown: ${result.maxDrawdown.times(100).toFixed(2)}%`,
    `Annualized return: ${annualizedPct.toFixed(2)}%`,
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
  days: number,
): string {
  if (!results.length) {
    return "No optimization results (no valid parameter combinations produced trades).";
  }

  const show = Math.min(topN, results.length);
  const cs = getCurrSymbol(symbol);
  const lines = [
    `Grid Optimization Results for ${symbol}`,
    "=".repeat(90),
    `Data: ${candleCount} candles (${resolution} resolution, ${days} days)`,
    `Tested ${totalCombos} parameter combinations`,
    "",
    `Top ${show} by Total P&L:`,
    `${"Rank".padEnd(5)} ${"Levels".padEnd(8)} ${"Range".padEnd(8)} ${"Realized".padEnd(12)} ${"Total P&L".padEnd(12)} ${"ROI".padEnd(10)} ${"Trades".padEnd(8)} ${"Drawdown".padEnd(10)} ${"$/Trade".padEnd(10)}`,
    "-".repeat(100),
  ];

  for (let i = 0; i < show; i++) {
    const r = results[i];
    lines.push(
      `${String(i + 1).padEnd(5)} ` +
        `${String(r.gridLevels / 2).padEnd(8)} ` +
        `${r.rangePct.times(100).toFixed(1)}%${"".padEnd(4)} ` +
        `${cs}${r.realizedPnl.toFixed(2).padStart(9)} ` +
        `${cs}${r.totalReturn.toFixed(2).padStart(9)} ` +
        `${r.returnPct.toFixed(2).padStart(8)}% ` +
        `${String(r.totalTrades).padEnd(8)} ` +
        `${r.maxDrawdown.times(100).toFixed(2).padStart(7)}% ` +
        `${cs}${r.profitPerTrade.toFixed(2).padStart(7)}`,
    );
  }

  lines.push("=".repeat(100));
  lines.push("");
  lines.push("Best by Metric:");
  lines.push("-".repeat(50));

  const bestReturn = results.reduce((best, r) =>
    r.totalReturn.gt(best.totalReturn) ? r : best,
  );
  lines.push(
    `  Highest Total P&L:  ${bestReturn.gridLevels / 2} levels/side, ` +
      `${bestReturn.rangePct.times(100).toFixed(1)}% range -> ` +
      `Realized: ${cs}${bestReturn.realizedPnl.toFixed(2)} | Total: ${cs}${bestReturn.totalReturn.toFixed(2)}`,
  );

  const bestCalmar = results.reduce((best, r) =>
    r.calmarApprox.gt(best.calmarApprox) ? r : best,
  );
  lines.push(
    `  Best Risk-Adj:   ${bestCalmar.gridLevels / 2} levels/side, ` +
      `${bestCalmar.rangePct.times(100).toFixed(1)}% range -> Calmar ${bestCalmar.calmarApprox.toFixed(2)}`,
  );

  const mostTrades = results.reduce((best, r) =>
    r.totalTrades > best.totalTrades ? r : best,
  );
  lines.push(
    `  Most Trades:     ${mostTrades.gridLevels / 2} levels/side, ` +
      `${mostTrades.rangePct.times(100).toFixed(1)}% range -> ${mostTrades.totalTrades} trades`,
  );

  const lowestDd = results.reduce((best, r) =>
    r.maxDrawdown.lt(best.maxDrawdown) ? r : best,
  );
  lines.push(
    `  Lowest Drawdown: ${lowestDd.gridLevels / 2} levels/side, ` +
      `${lowestDd.rangePct.times(100).toFixed(1)}% range -> ${lowestDd.maxDrawdown.times(100).toFixed(2)}%`,
  );

  return lines.join("\n");
}

export function registerBacktestTools(server: McpServer): void {
  server.registerTool(
    "grid_backtest",
    {
      title: "Run Grid Backtest",
      description:
        "Run a grid trading backtest on historical candle data from Revolut X. " +
        "Simulates a grid strategy: places buy orders at geometrically spaced price levels " +
        "below the starting price, sells at the next level above. " +
        "If the requested date range contains more than 50,000 candles, it defaults to returning the last 50,000 candles from the current timestamp.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD".'),
        grid_levels: z
          .number()
          .default(5)
          .describe(
            "Grid levels per side (default 5, range 2-25). Total orders = 2 × levels.",
          ),
        range_pct: z
          .string()
          .default("10")
          .describe(
            'Grid range as percentage of starting price, e.g. "10" for ±10%.',
          ),
        investment: z
          .string()
          .default("1000")
          .describe('Total investment in quote currency (default "1000").'),
        resolution: z
          .string()
          .default("1m")
          .describe(
            'Candle interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 2d, 4d, 1w, 2w, 4w (default "1m").',
          ),
        days: z
          .number()
          .default(3)
          .describe("Days of historical data to fetch (default 3)."),
        split_investment: z
          .boolean()
          .default(false)
          .describe(
            "Split investment across buy and sell levels. Market-buys base for sell levels above the starting price at grid creation.",
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
      days,
      split_investment,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const error = validateSymbol(symbol);
      if (error) return textResult(error);

      if (grid_levels < 2 || grid_levels > 25) {
        return textResult(
          `grid_levels must be between 2 and 25 (per side), got ${grid_levels}.`,
        );
      }
      const totalLevels = grid_levels * 2;

      const resError = validateResolution(resolution);
      if (resError) return resError;

      const [rawRange, rangeErr] = parseDecimal(range_pct, "range_pct");
      if (rangeErr) return textResult(rangeErr);
      const rangeDec = rawRange!.div(100);

      const [investDec, err2] = parseDecimal(investment, "investment");
      if (err2) return textResult(err2);

      if (days < 1 || days > 365) {
        return textResult(`days must be between 1 and 365, got ${days}.`);
      }

      const fetchResult = await fetchBacktestCandles(
        symbol,
        resolution,
        days,
        (opts) => getRevolutXClient().getCandles(symbol, opts),
        SETUP_GUIDE,
      );
      if ("error" in fetchResult) return fetchResult.error;
      const { candles, actualDays, llmNotice } = fetchResult;

      const result = runBacktest(candles, totalLevels, rangeDec, investDec!, split_investment);

      return textResult(
        formatBacktestResult(
          result,
          symbol,
          candles,
          resolution,
          totalLevels,
          rangeDec,
          investDec!,
          actualDays,
          split_investment,
        ) + llmNotice,
      );
    },
  );

  server.registerTool(
    "grid_optimize",
    {
      title: "Optimize Grid Parameters",
      description:
        "Test multiple grid parameter combinations and return ranked results. " +
        "Runs grid backtest for every combination of grid levels and range percentages, " +
        "then ranks by total return. If the requested date range contains more than 50,000 candles, " +
        "it defaults to testing against the last 50,000 candles from the current timestamp.",
      inputSchema: {
        symbol: z.string().describe('Trading pair symbol, e.g. "BTC-USD".'),
        investment: z
          .string()
          .default("1000")
          .describe('Total investment in quote currency (default "1000").'),
        resolution: z
          .string()
          .default("1m")
          .describe('Candle interval (default "1m").'),
        days: z
          .number()
          .default(3)
          .describe("Days of historical data to fetch (default 3)."),
        grid_levels_options: z
          .string()
          .default("3,5,8,10,15")
          .describe(
            "Comma-separated grid levels per side to test (each 2-25).",
          ),
        range_pct_options: z
          .string()
          .default("3,5,7,10,12,15,20")
          .describe("Comma-separated range percentages to test."),
        top_n: z
          .number()
          .default(10)
          .describe("Number of top results to show (default 10, max 50)."),
        split_investment: z
          .boolean()
          .default(false)
          .describe(
            "Split investment across buy and sell levels. Market-buys base for sell levels above the starting price at grid creation.",
          ),
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
      days,
      grid_levels_options,
      range_pct_options,
      top_n,
      split_investment,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      symbol = symbol.trim().toUpperCase();
      const symError = validateSymbol(symbol);
      if (symError) return textResult(symError);

      const resError = validateResolution(resolution);
      if (resError) return resError;

      const [investDec, err1] = parseDecimal(investment, "investment");
      if (err1) return textResult(err1);

      if (days < 1 || days > 365) {
        return textResult(`days must be between 1 and 365, got ${days}.`);
      }

      let levelsList: number[];
      try {
        levelsList = grid_levels_options
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x)
          .map((x) => {
            const n = parseInt(x, 10);
            if (isNaN(n) || n < 2 || n > 25) throw new Error();
            return n * 2;
          });
      } catch {
        return textResult(
          "grid_levels_options must be comma-separated integers between 2 and 25 (per side).",
        );
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

      const fetchResult = await fetchBacktestCandles(
        symbol,
        resolution,
        days,
        (opts) => getRevolutXClient().getCandles(symbol, opts),
        SETUP_GUIDE,
      );
      if ("error" in fetchResult) return fetchResult.error;
      const { candles, actualDays, llmNotice } = fetchResult;

      const results = optimizeGridParams(
        candles,
        levelsList,
        rangesList,
        investDec!,
        actualDays,
        split_investment,
      );

      return textResult(
        formatOptimizationResults(
          results,
          symbol,
          candles.length,
          resolution,
          totalCombos,
          top_n,
          actualDays,
        ) + llmNotice,
      );
    },
  );
}
