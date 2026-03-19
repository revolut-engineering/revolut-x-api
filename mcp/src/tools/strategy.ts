import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfigDir } from "revolutx-api";
import { textResult, validateSymbol, CLI_INSTALL_HINT } from "./_helpers.js";

const VALID_ACTIONS = ["backtest", "optimize", "run"] as const;

const STATE_PREFIX = "grid_state_";

interface GridLevelState {
  index: number;
  price: string;
  buyOrderId: string | null;
  sellOrderId: string | null;
  hasPosition: boolean;
  baseHeld: string;
  fillCost: string;
}

interface GridTradeEntry {
  ts: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  profit?: string;
  orderId: string;
}

interface GridState {
  id: string;
  pair: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  config: {
    levels: number;
    rangePct: string;
    investment: string;
    splitInvestment: boolean;
    intervalSec: number;
    dryRun: boolean;
  };
  splitExecuted: boolean;
  gridPrice: string;
  quotePerLevel: string;
  levels: GridLevelState[];
  stats: {
    totalBuys: number;
    totalSells: number;
    realizedPnl: string;
  };
  tradeLog: GridTradeEntry[];
}

function stateFilePath(pair: string): string {
  const safePair = pair.replace(/[^a-zA-Z0-9-]/g, "_");
  return join(getConfigDir(), `${STATE_PREFIX}${safePair}.json`);
}

function loadGridState(pair: string): GridState | null {
  const path = stateFilePath(pair);
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (data && typeof data === "object" && "id" in data) {
      const state = data as GridState;
      if (
        !state.quotePerLevel &&
        (data as Record<string, unknown>).usdPerLevel
      ) {
        state.quotePerLevel = (data as Record<string, unknown>)
          .usdPerLevel as string;
      }
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

function listGridStates(): string[] {
  const dir = getConfigDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(STATE_PREFIX) && f.endsWith(".json"))
      .map((f) => f.slice(STATE_PREFIX.length, -5).replace(/_/g, "-"));
  } catch {
    return [];
  }
}

function formatGridState(state: GridState): string {
  const lines: string[] = [];

  lines.push(`Grid Bot Status: ${state.pair}`);
  lines.push("=".repeat(50));
  lines.push(`Strategy ID: ${state.id}`);
  lines.push(`Created: ${state.createdAt}`);
  lines.push(`Updated: ${state.updatedAt}`);
  lines.push(`Mode: ${state.config.dryRun ? "DRY RUN" : "LIVE"}`);
  lines.push("");

  lines.push("Configuration");
  lines.push("-".repeat(50));
  const rangePct = (parseFloat(state.config.rangePct) * 100).toFixed(1);
  lines.push(`Grid Price: $${state.gridPrice}`);
  lines.push(`Range: ±${rangePct}%`);
  lines.push(`Levels: ${state.config.levels}`);
  lines.push(`Investment: $${state.config.investment}`);
  lines.push(`Per Level: $${state.quotePerLevel}`);
  lines.push(`Interval: ${state.config.intervalSec}s`);
  lines.push("");

  lines.push("Statistics");
  lines.push("-".repeat(50));
  lines.push(`Total Buys: ${state.stats.totalBuys}`);
  lines.push(`Total Sells: ${state.stats.totalSells}`);
  lines.push(`Realized P&L: $${state.stats.realizedPnl}`);
  lines.push("");

  lines.push("Grid Levels");
  lines.push("-".repeat(50));
  let positions = 0;
  let buyOrders = 0;
  let sellOrders = 0;
  let heldCount = 0;
  for (const lv of state.levels) {
    if (lv.hasPosition) positions++;
    if (lv.buyOrderId) buyOrders++;
    if (lv.sellOrderId) sellOrders++;
    const sellAbove =
      lv.index + 1 < state.levels.length &&
      !!state.levels[lv.index + 1]?.sellOrderId;
    if (lv.hasPosition && !sellAbove) heldCount++;
  }
  const parts = [`${buyOrders} buy orders`, `${sellOrders} sell orders`];
  if (positions > 0) parts.push(`${positions} positions`);
  if (heldCount > 0) parts.push(`${heldCount} HELD (no sell above)`);
  lines.push(parts.join(", "));

  for (const lv of [...state.levels].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price),
  )) {
    const hasSell = !!lv.sellOrderId;
    const hasPos = lv.hasPosition;
    const sellAbove =
      lv.index + 1 < state.levels.length &&
      !!state.levels[lv.index + 1]?.sellOrderId;
    const isHeld = hasPos && !sellAbove;

    let status: string;
    if (hasSell) {
      const buyBelow = state.levels[lv.index - 1];
      const baseAmt = buyBelow?.hasPosition ? buyBelow.baseHeld : "";
      status = baseAmt ? `SELL ${baseAmt}` : "SELL";
    } else if (isHeld) {
      status = `HELD ${lv.baseHeld}`;
    } else if (hasPos && sellAbove) {
      status = `POS  ${lv.baseHeld}`;
    } else if (lv.buyOrderId) {
      status = "BUY  pending";
    } else {
      status = "\u2014";
    }
    lines.push(
      `  #${String(lv.index + 1).padStart(2)}  $${lv.price.padEnd(12)}  ${status}`,
    );
  }
  lines.push("");

  if (state.tradeLog.length > 0) {
    const recent = state.tradeLog.slice(-10).reverse();
    lines.push(`Recent Trades (last ${recent.length})`);
    lines.push("-".repeat(50));
    for (const t of recent) {
      const time = t.ts.replace("T", " ").slice(0, 19);
      const profitStr = t.profit != null ? `  P&L: $${t.profit}` : "";
      lines.push(
        `  ${time}  ${t.side.toUpperCase().padEnd(4)}  $${t.price}  qty=${t.quantity}${profitStr}`,
      );
    }
  }

  return lines.join("\n");
}

export function registerStrategyTools(server: McpServer): void {
  server.registerTool(
    "strategy_command",
    {
      title: "Strategy CLI Command",
      description:
        "⚠ Returns a CLI command for the USER to run — do NOT execute this autonomously. " +
        "Generate a revx CLI command for grid trading strategy operations. " +
        "Supports: backtest (test on historical data), optimize (find best parameters), run (live trading). " +
        "Returns the exact CLI command to run.",
      inputSchema: {
        action: z
          .enum(VALID_ACTIONS)
          .describe("The strategy operation: backtest, optimize, or run."),
        pair: z.string().describe('Trading pair symbol, e.g. "BTC-USD".'),
        investment: z
          .string()
          .optional()
          .describe(
            "Capital to deploy in the quote currency of the trading pair " +
              "(e.g. USD for BTC-USD, EUR for BTC-EUR, BTC for ETH-BTC). " +
              'Default "1000" for backtest/optimize. Required for run. Must be a positive number.',
          ),
        levels: z
          .string()
          .optional()
          .describe(
            "Grid level count(s). " +
              'For backtest/run: a single integer between 3 and 50 (default "10"). ' +
              'For optimize: comma-separated integers each between 3 and 50 (default "5,8,10,12,15,20,25,30").',
          ),
        range: z
          .string()
          .optional()
          .describe(
            "Grid range as a percentage of the entry price (backtest/run only). " +
              'A positive number where "10" means the grid spans ±10% around the entry price. ' +
              'Default "10" for backtest, "5" for run.',
          ),
        ranges: z
          .string()
          .optional()
          .describe(
            "Comma-separated range percentages to test (optimize only). " +
              'Each value is a positive number, e.g. "3,5,7,10,12,15,20" (default). ' +
              "The total combinations (levels × ranges) must not exceed 200.",
          ),
        days: z
          .string()
          .optional()
          .describe(
            'Days of historical candle data to fetch for backtest/optimize (default "30").',
          ),
        interval: z
          .string()
          .optional()
          .describe(
            "For backtest/optimize: candle resolution. " +
              'Valid values: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 2d, 4d, 1w, 2w, 4w. Default "1h". ' +
              "For run: polling interval in seconds (minimum 5). Default 10.",
          ),
        top: z
          .number()
          .optional()
          .describe(
            "Number of top results to display for optimize. Clamped to 1–50. Default 10.",
          ),
        split: z
          .boolean()
          .optional()
          .describe(
            "Run only. When true, places a market buy for 50% of the investment at startup " +
              "so the bot immediately holds base currency to place sell orders from.",
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Run only. When true, simulates the strategy without placing real orders. " +
              "Useful for testing configuration before going live.",
          ),
        json: z
          .boolean()
          .optional()
          .describe(
            "Backtest/optimize only. When true, adds --json to the command so output is " +
              "printed as a JSON object instead of the formatted table.",
          ),
        output: z
          .string()
          .optional()
          .describe(
            'Backtest/optimize only. Output format flag. Pass "json" to add --output json ' +
              "to the command (alternative to the json boolean flag).",
          ),
      },
      annotations: {
        title: "Strategy CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      action,
      pair,
      investment,
      levels,
      range,
      ranges,
      days,
      interval,
      top,
      split,
      dry_run,
      json,
      output,
    }) => {
      if (!pair || !pair.trim()) return textResult("pair is required.");
      pair = pair.trim().toUpperCase();
      const error = validateSymbol(pair);
      if (error) return textResult(error);

      switch (action) {
        case "backtest": {
          const parts = ["revx strategy grid backtest", pair];
          if (levels) parts.push("--levels", levels.trim());
          if (range) parts.push("--range", range.trim());
          if (investment) parts.push("--investment", investment.trim());
          if (days) parts.push("--days", days.trim());
          if (interval) parts.push("--interval", interval.trim());
          if (json) parts.push("--json");
          if (output) parts.push("--output", output.trim());

          return textResult(
            `Action: Run a grid backtest on historical data\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `This fetches candle data and simulates a grid trading strategy, ` +
              `showing total trades, realized P&L, net return, and max drawdown.` +
              CLI_INSTALL_HINT,
          );
        }

        case "optimize": {
          const parts = ["revx strategy grid optimize", pair];
          if (investment) parts.push("--investment", investment.trim());
          if (days) parts.push("--days", days.trim());
          if (interval) parts.push("--interval", interval.trim());
          if (levels) parts.push("--levels", levels.trim());
          if (ranges) parts.push("--ranges", ranges.trim());
          if (top !== undefined) parts.push("--top", String(top));
          if (json) parts.push("--json");
          if (output) parts.push("--output", output.trim());

          return textResult(
            `Action: Optimize grid parameters\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `This tests multiple combinations of grid levels and range percentages, ` +
              `then ranks results by total return.` +
              CLI_INSTALL_HINT,
          );
        }

        case "run": {
          if (!investment) {
            return textResult("investment is required for the run action.");
          }

          const parts = [
            "revx strategy grid run",
            pair,
            "--investment",
            investment.trim(),
          ];
          if (levels) parts.push("--levels", levels.trim());
          if (range) parts.push("--range", range.trim());
          if (split) parts.push("--split");
          if (interval) parts.push("--interval", interval.trim());
          if (dry_run) parts.push("--dry-run");

          const modeLabel = dry_run ? " (dry run)" : "";
          return textResult(
            `Action: Start a live grid trading bot${modeLabel}\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `This starts a foreground process with a real-time dashboard. ` +
              `Press Ctrl+C to stop. If leftover orders exist from a previous ` +
              `session, they are automatically reconciled on startup.` +
              CLI_INSTALL_HINT,
          );
        }
      }
    },
  );

  server.registerTool(
    "grid_status",
    {
      title: "Grid Bot Status",
      description:
        "Read the saved state of a grid trading bot for a specific trading pair. " +
        "Shows strategy config, grid levels with positions/orders, P&L stats, and recent trades.",
      inputSchema: {
        pair: z
          .string()
          .describe(
            'Trading pair symbol, e.g. "BTC-USD". Use grid_states_list to see available pairs.',
          ),
      },
      annotations: {
        title: "Grid Bot Status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ pair }) => {
      if (!pair || !pair.trim()) return textResult("pair is required.");
      pair = pair.trim().toUpperCase();
      const error = validateSymbol(pair);
      if (error) return textResult(error);

      const state = loadGridState(pair);
      if (!state) {
        return textResult(
          `No saved grid state found for ${pair}.\n\n` +
            "Use 'grid_states_list' to see available pairs, or start a new grid bot:\n" +
            `  revx strategy grid run ${pair} --investment 500`,
        );
      }

      return textResult(formatGridState(state));
    },
  );

  server.registerTool(
    "grid_states_list",
    {
      title: "List Grid Bot States",
      description:
        "List all saved grid bot states. Returns the trading pairs that have saved state files " +
        "(from crashes or partial cancellations), which can be inspected with grid_status.",
      annotations: {
        title: "List Grid Bot States",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const pairs = listGridStates();
      if (pairs.length === 0) {
        return textResult(
          "No saved grid bot states found.\n\n" +
            "Start a grid bot with:\n" +
            "  revx strategy grid run BTC-USD --investment 500",
        );
      }

      const lines = [
        `Saved Grid Bot States (${pairs.length})`,
        "=".repeat(40),
        "",
      ];
      for (const p of pairs.sort()) {
        const state = loadGridState(p);
        if (state) {
          const mode = state.config.dryRun ? " [DRY RUN]" : "";
          lines.push(
            `  ${p}${mode} — ${state.stats.totalBuys + state.stats.totalSells} trades, ` +
              `P&L: $${state.stats.realizedPnl}, updated ${state.updatedAt.replace("T", " ").slice(0, 19)}`,
          );
        } else {
          lines.push(`  ${p}`);
        }
      }

      lines.push("");
      lines.push("Use 'grid_status' with a pair name to see full details.");
      return textResult(lines.join("\n"));
    },
  );
}
