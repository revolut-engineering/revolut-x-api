import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeCandles(
  startMs: number,
  count: number,
  intervalMs: number,
  basePrice: number,
): Array<{
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}> {
  const candles = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open * (1 + (i % 3 === 0 ? 1 : -1) * 0.003);
    candles.push({
      start: startMs + i * intervalMs,
      open: open.toFixed(2),
      high: (open * 1.003).toFixed(2),
      low: (open * 0.997).toFixed(2),
      close: close.toFixed(2),
      volume: (10 + (i % 5)).toFixed(4),
    });
    price = close;
  }
  return candles;
}

const FINE_RESOLUTIONS = new Set(["1m", "5m", "15m", "30m"]);

describe("timeframe — candle resolution selection", () => {
  defineEval({
    name: "candle-coarse-resolution-for-weekly-trend",
    description:
      "Week-level trend question → resolution must be 1h or coarser; 1m/5m/15m/30m would produce thousands of candles unnecessarily.",
    failureModes: ["Timeframe resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "show me BTC-USD price trend over the last week",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValue({
        data: makeCandles(Date.now() - 7 * DAY_MS, 7, DAY_MS, 95000),
      });
    },
    assertions: [
      a.callsTool("get_candles"),
      {
        name: "resolution is 1h or coarser (not 1m/5m/15m/30m)",
        check: ({ toolCalls }) => {
          const call = toolCalls.find((c) => c.name === "get_candles");
          if (!call) return false;
          const resolution = (call.args as { resolution?: string }).resolution;
          if (!resolution) return true;
          return !FINE_RESOLUTIONS.has(resolution);
        },
      },
      a.judge({
        name: "summarises 7-day trend at hourly or coarser granularity",
        criterion:
          "Pass if: the answer summarises BTC-USD price movement over roughly a week using daily or hourly granularity; high-level trend description is acceptable. " +
          "Fail if: the answer implies minute-level resolution was used for a 7-day window (e.g. mentions thousands of candles or per-minute detail), or the resolution chosen is clearly finer than 1h.",
      }),
    ],
  });

  defineEval({
    name: "candle-daily-resolution-explicit",
    description:
      "Explicit 'daily candles' request → resolution must be exactly 1d, not 1h or finer.",
    failureModes: ["Timeframe resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "give me daily BTC-USD candles for the last 30 days",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValue({
        data: makeCandles(Date.now() - 30 * DAY_MS, 30, DAY_MS, 95000),
      });
    },
    assertions: [
      a.callsTool("get_candles"),
      {
        name: "resolution is exactly 1d",
        check: ({ toolCalls }) => {
          const call = toolCalls.find((c) => c.name === "get_candles");
          if (!call) return false;
          return (call.args as { resolution?: string }).resolution === "1d";
        },
      },
      a.judge({
        name: "presents daily candle data covering approximately 30 days",
        criterion:
          "Pass if: the answer presents BTC-USD price data at daily (1d) granularity for approximately 30 days. " +
          "Fail if: resolution is hourly or finer when the user explicitly requested daily, or the time window is substantially shorter than 30 days.",
      }),
    ],
  });

  defineEval({
    name: "candle-minute-resolution-intraday",
    description:
      "Explicit 'minute by minute' request for 1 hour → resolution must be 1m or 5m; coarser would collapse the hour into a single candle.",
    failureModes: ["Timeframe resolution"],
    granularity: "Tool-specific",
    workflow: "Market - Prices",
    prompt: "give me BTC-USD price action from the last hour, minute by minute",
    setup: () => {
      revolutXMockState.getCandles.mockResolvedValue({
        data: makeCandles(Date.now() - HOUR_MS, 60, 60_000, 95000),
      });
    },
    assertions: [
      a.callsTool("get_candles"),
      {
        name: "resolution is 1m or 5m for a minute-by-minute request",
        check: ({ toolCalls }) => {
          const call = toolCalls.find((c) => c.name === "get_candles");
          if (!call) return false;
          const resolution = (call.args as { resolution?: string }).resolution;
          return resolution === "1m" || resolution === "5m";
        },
      },
      a.judge({
        name: "presents per-minute or 5-minute granularity for the past hour",
        criterion:
          "Pass if: the answer presents BTC-USD price action at 1m or 5m granularity for approximately the past hour. " +
          "Fail if: resolution is 1h or coarser (which collapses the entire hour into a single candle), violating the explicit 'minute by minute' request.",
      }),
    ],
  });
});
