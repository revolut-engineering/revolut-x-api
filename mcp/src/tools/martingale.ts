import { Decimal } from "decimal.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  textResult,
  validateSymbol,
  validateResolution,
  handleApiError,
} from "../shared/_helpers.js";
import {
  runMartingaleBacktest,
  optimizeMartingaleParams,
  type MartingaleBacktestParams,
} from "../shared/backtest/index.js";
import { RESOLUTIONS_MAP } from "../shared/common.js";
import type { Candle } from "@revolut/revolut-x-api";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "€",
  GBP: "£",
};

function getCurrSymbol(symbol: string): string {
  const quote = symbol.split("-")[1] ?? "";
  return CURRENCY_SYMBOLS[quote] ?? "";
}

interface ParsedCandle {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  start?: number;
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
          start: c.start,
        },
      });
    } catch {
      continue;
    }
  }
  parsed.sort((a, b) => a.ts - b.ts);
  return parsed.map((p) => p.candle);
}

const LLM_NOTICE =
  "\n\n*** NOTE TO LLM: This output is a simulation of past data — NOT a prediction or guarantee of future performance. " +
  "When citing any figure from this output (ROI, P&L, drawdown, recommended parameters), explicitly include that caveat in your reply to the user. ***";

async function fetchMartingaleCandles(
  symbol: string,
  resolution: string,
  days: number,
  doFetch: (opts: {
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
  let llmNotice = LLM_NOTICE;

  if (expectedCandles > 50000) {
    startDate = now - 50000 * intervalMs;
    actualDays = Number(((now - startDate) / (24 * 60 * 60 * 1000)).toFixed(2));
    llmNotice =
      "\n\n*** NOTE TO LLM: This output is a simulation of past data — NOT a prediction or guarantee of future performance. " +
      "The requested range contained more than 50,000 candles; the simulation was run on the most recent 50,000 candles. " +
      "When citing any figure, explicitly include that caveat in your reply. ***";
  }

  let candleResult;
  try {
    candleResult = await doFetch({ interval: resolution, startDate });
  } catch (error) {
    const handled = await handleApiError(error, setupGuide);
    if (handled) return { error: handled };
    throw error;
  }

  const candles = parseCandles(candleResult.data);
  if (!candles.length) {
    return {
      error: textResult(
        `No candle data found for ${symbol} (${resolution}). Try a different resolution or pair.`,
      ),
    };
  }

  return { candles, actualDays, llmNotice };
}

export function registerMartingaleTools(server: McpServer): void {
  server.registerTool(
    "martingale_backtest",
    {
      title: "Run Martingale Backtest",
      description:
        "Simulate a martingale DCA strategy against historical candle data from Revolut X (no live orders are placed). " +
        "The martingale strategy places a series of buy orders at geometrically increasing sizes as price drops, " +
        "and sells the entire accumulated position when price reaches avgEntry × (1+takeProfit). " +
        "A stop-loss exits if price falls below initialBuyPrice × (1-stopLoss). " +
        "IMPORTANT: Confirm parameters with the user before running — they materially change the simulated outcome.",
      inputSchema: {
        symbol: z.string().describe('Trading pair, e.g. "BTC-USD"'),
        resolution: z
          .string()
          .default("1h")
          .describe(
            "Candle interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d (default 1h)",
          ),
        days: z
          .number()
          .default(30)
          .describe("Days of historical data (default 30)"),
        price_deviation_pct: z
          .number()
          .default(2)
          .describe(
            "% price drop between safety orders, e.g. 2 means 2% (default 2)",
          ),
        safety_order_volume_scale: z
          .number()
          .default(2.0)
          .describe("Capital multiplier per safety order level (default 2.0)"),
        max_safety_orders: z
          .number()
          .default(5)
          .describe("Maximum number of safety orders (default 5)"),
        take_profit_pct: z
          .number()
          .default(1.5)
          .describe("Take-profit % above average entry price (default 1.5)"),
        stop_loss_pct: z
          .number()
          .default(15)
          .describe("Stop-loss % below initial buy price (default 15)"),
        investment: z
          .string()
          .default("1000")
          .describe('Total investment in quote currency (default "1000")'),
      },
      annotations: {
        title: "Run Martingale Backtest",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({
      symbol,
      resolution,
      days,
      price_deviation_pct,
      safety_order_volume_scale,
      max_safety_orders,
      take_profit_pct,
      stop_loss_pct,
      investment,
    }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      const symErr = validateSymbol(symbol);
      if (symErr) return textResult(symErr);
      const resErr = validateResolution(resolution);
      if (resErr) return resErr;
      const pair = symbol.trim().toUpperCase();

      if (days < 1 || days > 365)
        return textResult(`days must be between 1 and 365, got ${days}.`);
      if (max_safety_orders < 0 || max_safety_orders > 30)
        return textResult(`max_safety_orders must be between 0 and 30.`);

      const priceDeviation = new Decimal(price_deviation_pct).div(100);
      const scale = new Decimal(safety_order_volume_scale);
      const takeProfit = new Decimal(take_profit_pct).div(100);
      const stopLoss = new Decimal(stop_loss_pct).div(100);

      const minSlRequired = new Decimal(1).minus(
        new Decimal(1).minus(priceDeviation).pow(max_safety_orders + 1),
      );
      if (stopLoss.lte(minSlRequired)) {
        return textResult(
          `stop_loss_pct (${stop_loss_pct}%) must exceed ${minSlRequired.times(100).toFixed(2)}% to place the stop-loss below all safety order levels. ` +
            `Increase stop_loss_pct, or decrease price_deviation_pct / max_safety_orders.`,
        );
      }

      let investDec: Decimal;
      try {
        investDec = new Decimal(investment);
        if (investDec.lte(0)) return textResult("investment must be positive.");
      } catch {
        return textResult(
          `investment must be a valid number, got '${investment}'.`,
        );
      }

      const fetchResult = await fetchMartingaleCandles(
        pair,
        resolution,
        days,
        (opts) => getRevolutXClient().getCandles(pair, opts),
        SETUP_GUIDE,
      );
      if ("error" in fetchResult) return fetchResult.error;
      const { candles, actualDays, llmNotice } = fetchResult;

      const params: MartingaleBacktestParams = {
        priceDeviation,
        safetyOrderVolumeScale: scale,
        maxSafetyOrders: max_safety_orders,
        takeProfit,
        stopLoss,
        investment: investDec,
      };
      const r = runMartingaleBacktest(candles, params);

      const cs = getCurrSymbol(pair);
      const annualizedPct =
        (Math.pow(1 + r.returnPct.toNumber() / 100, 365 / actualDays) - 1) *
        100;

      const lines: string[] = [
        `Martingale Backtest — ${pair}`,
        "═".repeat(50),
        `Candles:            ${candles.length} (${resolution}, ~${actualDays} days)`,
        `Price Deviation:    ${priceDeviation.times(100).toFixed(2)}%`,
        `Scale:              ${scale.toFixed(2)}`,
        `Max Safety Orders:  ${max_safety_orders}`,
        `Take Profit:        ${takeProfit.times(100).toFixed(2)}%`,
        `Stop Loss:          ${stopLoss.times(100).toFixed(2)}%`,
        `Investment:         ${cs}${investDec.toFixed(2)}`,
        "",
        `Completed Cycles:   ${r.completedCycles} (${r.winningCycles} wins)`,
        `Stop-Loss Hits:     ${r.stopLossCount}`,
        `Total Trades:       ${r.totalTrades}`,
        `Realized P&L:       ${cs}${r.realizedPnl.toFixed(2)}`,
        `Total Return:       ${cs}${r.totalReturn.toFixed(2)}`,
        `ROI:                ${r.returnPct.gte(0) ? "+" : ""}${r.returnPct.toFixed(2)}%`,
        `Annualized:         ${annualizedPct >= 0 ? "+" : ""}${annualizedPct.toFixed(2)}%`,
        `Max Drawdown:       ${cs}${r.maxDrawdown.toFixed(2)}`,
      ];

      if (r.tradeLog.length > 0) {
        lines.push("", "Recent Trades (last 10):");
        for (const t of r.tradeLog.slice(-10)) lines.push(`  ${t}`);
        if (r.tradeLog.length > 10)
          lines.push(`  … and ${r.tradeLog.length - 10} more`);
      }

      lines.push(llmNotice);
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "martingale_optimize",
    {
      title: "Optimize Martingale Parameters",
      description:
        "Sweep multiple martingale parameter combinations (priceDeviation × scale × maxSafetyOrders × takeProfit) " +
        "and rank by total return. Useful for finding optimal DCA parameters for a given pair and time period. " +
        "The stop-loss percentage is fixed across all combinations.",
      inputSchema: {
        symbol: z.string().describe('Trading pair, e.g. "BTC-USD"'),
        resolution: z
          .string()
          .default("1h")
          .describe(
            "Candle interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d (default 1h)",
          ),
        days: z
          .number()
          .default(30)
          .describe("Days of historical data (default 30)"),
        stop_loss_pct: z
          .number()
          .default(15)
          .describe(
            "Fixed stop-loss % below initial buy, applied to all combinations (default 15)",
          ),
        investment: z
          .string()
          .default("1000")
          .describe('Total investment in quote currency (default "1000")'),
        top: z
          .number()
          .default(10)
          .describe("Number of top results to return (default 10)"),
      },
      annotations: {
        title: "Optimize Martingale Parameters",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ symbol, resolution, days, stop_loss_pct, investment, top }) => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");

      const symErr = validateSymbol(symbol);
      if (symErr) return textResult(symErr);
      const resErr = validateResolution(resolution);
      if (resErr) return resErr;
      const pair = symbol.trim().toUpperCase();

      if (days < 1 || days > 365)
        return textResult(`days must be between 1 and 365, got ${days}.`);

      const stopLoss = new Decimal(stop_loss_pct).div(100);

      let investDec: Decimal;
      try {
        investDec = new Decimal(investment);
        if (investDec.lte(0)) return textResult("investment must be positive.");
      } catch {
        return textResult(
          `investment must be a valid number, got '${investment}'.`,
        );
      }

      const fetchResult = await fetchMartingaleCandles(
        pair,
        resolution,
        days,
        (opts) => getRevolutXClient().getCandles(pair, opts),
        SETUP_GUIDE,
      );
      if ("error" in fetchResult) return fetchResult.error;
      const { candles, actualDays, llmNotice } = fetchResult;

      const results = optimizeMartingaleParams(candles, investDec, stopLoss);
      const topResults = results.slice(0, top);

      const cs = getCurrSymbol(pair);
      const lines: string[] = [
        `Martingale Optimization — ${pair} (${resolution}, ~${actualDays} days)`,
        `Stop-Loss: ${stopLoss.times(100).toFixed(2)}%  |  Investment: ${cs}${investDec.toFixed(2)}`,
        `Tested ${results.length} parameter combinations`,
        "",
        "─".repeat(75),
        " # | Dev%  | Scale | SO | TP%   | P&L       | ROI%    | Cycles | SL hits",
        "─".repeat(75),
      ];

      for (let i = 0; i < topResults.length; i++) {
        const r = topResults[i];
        const roiStr = `${r.returnPct.gte(0) ? "+" : ""}${r.returnPct.toFixed(2)}%`;
        lines.push(
          `${String(i + 1).padStart(2)} | ` +
            `${r.priceDeviation.times(100).toFixed(2).padStart(4)}% | ` +
            `${r.safetyOrderVolumeScale.toFixed(2).padStart(5)} | ` +
            `${String(r.maxSafetyOrders).padStart(2)} | ` +
            `${r.takeProfit.times(100).toFixed(2).padStart(4)}% | ` +
            `${`${cs}${r.realizedPnl.toFixed(2)}`.padStart(9)} | ` +
            `${roiStr.padStart(7)} | ` +
            `${String(r.completedCycles).padStart(6)} | ${r.stopLossCount}`,
        );
      }
      lines.push("─".repeat(75));
      lines.push(llmNotice);
      return textResult(lines.join("\n"));
    },
  );
}
