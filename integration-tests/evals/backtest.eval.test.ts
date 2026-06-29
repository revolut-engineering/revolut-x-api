import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const HOUR_MS = 60 * 60 * 1000;

function makeHourlyCandles(startMs: number, count: number, basePrice: number) {
  const candles = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const swing = Math.sin(i / 6) * basePrice * 0.02;
    const close = open + swing;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    candles.push({
      start: startMs + i * HOUR_MS,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volume: (40 + Math.abs(Math.sin(i)) * 25).toFixed(4),
    });
    price = close;
  }
  return candles;
}

describe("grid simulation flow", () => {
  defineEval({
    name: "backtest-confirm-then-run",
    description:
      "User asks for a backtest with sparse params. Agent must confirm key params OR include a simulation caveat if it proceeds.",
    prompt:
      "backtest a grid bot on ETH-USD with 10000 dollars — use 5 levels, 10% range, no split investment",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValueOnce({
        data: makeHourlyCandles(Date.now() - 30 * 24 * HOUR_MS, 720, 3500),
      });
    },
    assertions: [
      {
        name: "calls grid_backtest at most once with explicit user-supplied params",
        check: ({ toolCalls }) => {
          const calls = toolCalls.filter((c) => c.name === "grid_backtest");
          if (calls.length !== 1) return false;
          const args = calls[0].args as {
            symbol?: string;
            investment?: string;
            grid_levels?: number;
            range_pct?: string;
            split_investment?: boolean;
          };
          if (args.symbol !== "ETH-USD") return false;
          if (args.investment !== "10000") return false;
          if (args.grid_levels !== 5) return false;
          if (args.split_investment !== false) return false;
          return true;
        },
      },
      a.doesNotCallTool("get_active_orders"),
      a.doesNotCallTool("get_historical_orders"),
      a.judge({
        name: "surfaces the simulation-not-prediction caveat when reporting results",
        criterion:
          "Pass if: the answer notes — even vaguely — that the backtest result is a simulation of past data and not a prediction or guarantee of future performance. " +
          "Fail if: the caveat is entirely absent, or the answer treats the backtest result as a forecast.",
      }),
    ],
  });

  defineEval({
    name: "optimize-grid-params",
    description:
      "Optimization happy path → grid_optimize; caveat about simulation still required.",
    prompt:
      "find me a good grid setup for BTC-USD on the last 3 days, 5000 USD investment, no split",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValueOnce({
        data: makeHourlyCandles(Date.now() - 3 * 24 * HOUR_MS, 72, 95000),
      });
    },
    assertions: [
      a.callsTool("grid_optimize"),
      a.callsToolWithArgs("grid_optimize", {
        symbol: "BTC-USD",
        investment: "5000",
      }),
      a.doesNotCallTool("grid_backtest"),
      a.judge({
        name: "ranks combos and includes simulation caveat",
        criterion:
          "Pass if: the answer presents the top-ranked grid parameter combination (levels per side and range %) with its ROI or total P&L, AND includes an explicit simulation caveat stating these are past-data results, not guarantees. " +
          "Fail if: the ranking is missing, the ROI is absent, or the simulation caveat is absent or only vaguely implied.",
      }),
    ],
  });
});
