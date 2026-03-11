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
  gridPrice: string;
  usdPerLevel: string;
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
      return data as GridState;
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
  lines.push(`Per Level: $${state.usdPerLevel}`);
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
  for (const lv of state.levels) {
    if (lv.hasPosition) positions++;
    if (lv.buyOrderId) buyOrders++;
    if (lv.sellOrderId) sellOrders++;
  }
  lines.push(
    `${positions} with position, ${buyOrders} buy orders, ${sellOrders} sell orders`,
  );

  for (const lv of [...state.levels].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price),
  )) {
    let status: string;
    if (lv.hasPosition) {
      status = `POS  ${lv.baseHeld}`;
    } else if (lv.sellOrderId) {
      status = "SELL pending";
    } else if (lv.buyOrderId) {
      status = "BUY  pending";
    } else {
      status = "—";
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
            'Capital in USD (default "1000" for backtest/optimize, required for run).',
          ),
        levels: z
          .string()
          .optional()
          .describe(
            'Grid levels. Single number for backtest/run (default "10"), comma-separated for optimize (default "5,8,10,12,15,20,25,30").',
          ),
        range: z
          .string()
          .optional()
          .describe(
            'Grid range as percentage for backtest/run, e.g. "10" for ±10% (default "10" backtest, "5" run).',
          ),
        ranges: z
          .string()
          .optional()
          .describe(
            'Comma-separated range percentages for optimize (default "3,5,7,10,12,15,20").',
          ),
        days: z
          .string()
          .optional()
          .describe(
            'Days of historical data for backtest/optimize (default "30").',
          ),
        interval: z
          .string()
          .optional()
          .describe(
            'Candle resolution for backtest/optimize (default "1h"), or polling interval in seconds for run (default "30").',
          ),
        top: z
          .number()
          .optional()
          .describe("Number of top results for optimize (default 10)."),
        split: z
          .boolean()
          .optional()
          .describe("Market-buy 50% of investment at start (run only)."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Simulate without placing real orders (run only)."),
        resume: z
          .boolean()
          .optional()
          .describe("Resume from previously saved state (run only)."),
      },
      annotations: {
        title: "Strategy CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
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
      resume,
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

          return textResult(
            `Action: Optimize grid parameters\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `This tests multiple combinations of grid levels and range percentages, ` +
              `then ranks results by total return.` +
              CLI_INSTALL_HINT,
          );
        }

        case "run": {
          if (resume) {
            const parts = ["revx strategy grid run", pair, "--resume"];
            if (interval) parts.push("--interval", interval.trim());

            return textResult(
              `Action: Resume a live grid bot from saved state\n\n` +
                `Command:\n  ${parts.join(" ")}\n\n` +
                `This resumes a previously saved grid bot, reconciling any orders ` +
                `that filled while offline. Press Ctrl+C to stop.` +
                CLI_INSTALL_HINT,
            );
          }

          if (!investment) {
            return textResult(
              "investment is required for the run action (or use resume: true to continue from saved state).",
            );
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
              `Press Ctrl+C to stop. State is saved automatically for resume.` +
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
        "List all saved grid bot states. Returns the trading pairs that have saved state files, " +
        "which can be inspected with grid_status or resumed with the strategy run command.",
      annotations: {
        title: "List Grid Bot States",
        readOnlyHint: true,
        destructiveHint: false,
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
