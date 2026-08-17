import { Decimal } from "decimal.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  textResult,
  validateSymbol,
  validateResolution,
  getCurrSymbol,
  fetchCandles,
} from "../shared/_helpers.js";
import {
  runMartingaleBacktest,
  optimizeMartingaleParams,
  type MartingaleBacktestParams,
} from "../shared/backtest/index.js";

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
            "% price drop between safety orders, >= 1%, e.g. 2 means 2% (default 2)",
          ),
        safety_order_volume_scale: z
          .number()
          .default(2.0)
          .describe(
            "Capital multiplier per safety order level, >= 1 (default 2.0)",
          ),
        max_safety_orders: z
          .number()
          .default(5)
          .describe("Maximum number of safety orders, 1–30 (default 5)"),
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
      if (price_deviation_pct < 1)
        return textResult(
          `price_deviation_pct must be >= 1%, got ${price_deviation_pct}.`,
        );
      if (safety_order_volume_scale < 1)
        return textResult(
          `safety_order_volume_scale must be >= 1, got ${safety_order_volume_scale}.`,
        );
      if (max_safety_orders < 1 || max_safety_orders > 30)
        return textResult(
          `max_safety_orders must be between 1 and 30, got ${max_safety_orders}.`,
        );

      const priceDeviation = new Decimal(price_deviation_pct).div(100);
      const scale = new Decimal(safety_order_volume_scale);
      const takeProfit = new Decimal(take_profit_pct).div(100);
      const stopLoss = new Decimal(stop_loss_pct).div(100);

      const minSlRequired = new Decimal(1).minus(
        new Decimal(1).minus(priceDeviation).pow(max_safety_orders),
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

      const fetchResult = await fetchCandles(
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

      const fetchResult = await fetchCandles(
        pair,
        resolution,
        days,
        (opts) => getRevolutXClient().getCandles(pair, opts),
        SETUP_GUIDE,
      );
      if ("error" in fetchResult) return fetchResult.error;
      const { candles, actualDays, llmNotice } = fetchResult;

      const results = optimizeMartingaleParams(candles, investDec, {
        stopLoss,
        days: actualDays,
      });
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

      if (results.length > 0) {
        const bestReturn = results[0];
        const bestCalmar = results.reduce((b, r) =>
          r.calmarApprox.gt(b.calmarApprox) ? r : b,
        );
        const lowestDd = results.reduce((b, r) =>
          r.maxDrawdown.lt(b.maxDrawdown) ? r : b,
        );
        const fmtCombo = (r: (typeof results)[0]) =>
          `dev=${r.priceDeviation.times(100).toFixed(1)}% scale=${r.safetyOrderVolumeScale.toFixed(1)} SO=${r.maxSafetyOrders} TP=${r.takeProfit.times(100).toFixed(1)}%`;
        lines.push("");
        lines.push(
          `Best Total P&L : ${fmtCombo(bestReturn)} → Realized: ${cs}${bestReturn.realizedPnl.toFixed(2)} | Total: ${cs}${bestReturn.totalReturn.toFixed(2)}`,
        );
        lines.push(
          `Best Risk-Adj  : ${fmtCombo(bestCalmar)} → Calmar ${bestCalmar.calmarApprox.toFixed(2)}`,
        );
        lines.push(
          `Lowest Drawdown: ${fmtCombo(lowestDd)} → ${investDec.gt(0) ? lowestDd.maxDrawdown.div(investDec).times(100).toFixed(2) + "%" : "0%"}`,
        );
      }

      lines.push(llmNotice);
      return textResult(lines.join("\n"));
    },
  );
}
