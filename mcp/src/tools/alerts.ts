import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, validateSymbol, CLI_INSTALL_HINT } from "./_helpers.js";

const _ALERT_TYPE_DOCS: Record<
  string,
  { description: string; config_fields: string; example: string }
> = {
  price: {
    description:
      "Simple price threshold alert — triggers when price crosses above or below a level.",
    config_fields:
      "--direction (above/below), --threshold (price level, required).",
    example: "revx monitor price BTC-USD --direction above --threshold 100000",
  },
  rsi: {
    description:
      "Relative Strength Index — triggers when RSI crosses a threshold (overbought/oversold).",
    config_fields:
      "--direction (above/below), --threshold (0-100 scale, e.g. 70 = overbought; default 70), --period (default 14).",
    example: "revx monitor rsi ETH-USD --direction above --threshold 70",
  },
  ema_cross: {
    description:
      "EMA Crossover — triggers when fast EMA crosses above (bullish) or below (bearish) slow EMA.",
    config_fields:
      "--direction (bullish/bearish), --fast-period (default 9), --slow-period (default 21).",
    example: "revx monitor ema-cross BTC-USD --direction bullish",
  },
  macd: {
    description:
      "MACD Crossover — triggers when MACD line crosses signal line.",
    config_fields:
      "--direction (bullish/bearish), --fast (default 12), --slow (default 26), --signal (default 9).",
    example: "revx monitor macd BTC-USD --direction bullish",
  },
  bollinger: {
    description:
      "Bollinger Bands — triggers when price touches or crosses upper/lower band.",
    config_fields:
      "--band (upper/lower), --period (default 20), --std-mult (default 2).",
    example: "revx monitor bollinger BTC-USD --band upper",
  },
  volume_spike: {
    description:
      "Volume Spike — triggers when current volume exceeds a multiple of the average.",
    config_fields: "--period (default 20), --multiplier (default 2.0).",
    example: "revx monitor volume-spike BTC-USD",
  },
  spread: {
    description:
      "Bid-Ask Spread — triggers when spread percentage crosses a threshold.",
    config_fields:
      "--direction (above/below), --threshold (spread in %, e.g. 0.5 = 0.5%; default 0.5).",
    example: "revx monitor spread BTC-USD --direction above --threshold 0.5",
  },
  obi: {
    description:
      "Order Book Imbalance — triggers when buy/sell volume imbalance crosses a threshold.",
    config_fields:
      "--direction (above/below), --threshold (ratio from -1.0 to 1.0, e.g. 0.3 = 30% buy imbalance; default 0.3).",
    example: "revx monitor obi BTC-USD --direction above --threshold 0.3",
  },
  price_change_pct: {
    description:
      "Price Change % — triggers when price has risen or fallen by at least X% over the last N 1-hour candles.",
    config_fields:
      "--direction (rise/fall), --threshold (% change, e.g. 5 = 5%; default 5.0), --lookback (1h candles, default 24).",
    example:
      "revx monitor price-change BTC-USD --direction rise --threshold 5.0",
  },
  atr_breakout: {
    description:
      "ATR Breakout — triggers when price moves more than a multiple of ATR from previous close.",
    config_fields: "--period (default 14), --multiplier (default 1.5).",
    example: "revx monitor atr-breakout BTC-USD",
  },
};

const VALID_ALERT_TYPES = Object.keys(_ALERT_TYPE_DOCS);
const PRICE_DIRECTIONS = new Set(["above", "below"]);

const CMD_NAMES: Record<string, string> = {
  ema_cross: "ema-cross",
  volume_spike: "volume-spike",
  price_change_pct: "price-change",
  atr_breakout: "atr-breakout",
};

export function registerMonitorTools(server: McpServer): void {
  server.registerTool(
    "monitor_command",
    {
      title: "Monitor CLI Command",
      description:
        "Generate a revx CLI command to start monitoring a trading pair for alert conditions. " +
        "Returns the exact CLI command to run. Use 'monitor_types' to see all supported alert types.",
      inputSchema: {
        pair: z.string().describe('Trading pair symbol, e.g. "BTC-USD".'),
        alert_type: z
          .string()
          .optional()
          .default("price")
          .describe(
            'Alert type (default "price"). One of: price, rsi, ema_cross, macd, bollinger, volume_spike, spread, obi, price_change_pct, atr_breakout.',
          ),
        direction: z
          .string()
          .optional()
          .describe(
            "Condition direction. Price/spread/obi: above/below. EMA/MACD: bullish/bearish. Price change: rise/fall.",
          ),
        threshold: z
          .string()
          .optional()
          .describe(
            "Condition threshold value. For price: absolute price level. For spread: percentage (0.5 = 0.5%). For RSI: 0-100 scale. For OBI: ratio -1.0 to 1.0. For price_change_pct: % change (5 = 5%). Required for price type.",
          ),
        period: z
          .number()
          .optional()
          .describe(
            "Period for RSI (default 14), Bollinger (default 20), ATR breakout (default 14), volume spike (default 20).",
          ),
        fast_period: z
          .number()
          .optional()
          .describe("Fast EMA period for ema_cross (default 9)."),
        slow_period: z
          .number()
          .optional()
          .describe("Slow EMA period for ema_cross (default 21)."),
        fast: z
          .number()
          .optional()
          .describe("Fast EMA period for MACD (default 12)."),
        slow: z
          .number()
          .optional()
          .describe("Slow EMA period for MACD (default 26)."),
        signal: z
          .number()
          .optional()
          .describe("Signal line period for MACD (default 9)."),
        band: z
          .string()
          .optional()
          .describe(
            'Bollinger band to watch: "upper" or "lower" (default "upper").',
          ),
        std_mult: z
          .number()
          .optional()
          .describe("Bollinger standard deviation multiplier (default 2)."),
        multiplier: z
          .number()
          .optional()
          .describe(
            "Multiplier for volume_spike (default 2.0) and atr_breakout (default 1.5).",
          ),
        lookback: z
          .number()
          .optional()
          .describe(
            "Lookback in 1h candles for price_change_pct (default 24).",
          ),
        interval: z
          .number()
          .optional()
          .describe("Tick interval in seconds (minimum 5, default 10)."),
      },
      annotations: {
        title: "Monitor CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({
      pair,
      alert_type,
      direction,
      threshold,
      period,
      fast_period,
      slow_period,
      fast,
      slow,
      signal,
      band,
      std_mult,
      multiplier,
      lookback,
      interval,
    }) => {
      if (!pair || !pair.trim()) return textResult("pair is required.");

      pair = pair.trim().toUpperCase();
      const symError = validateSymbol(pair);
      if (symError) return textResult(symError);

      const alertType = (alert_type ?? "price").trim().toLowerCase();
      if (!(alertType in _ALERT_TYPE_DOCS)) {
        return textResult(
          `Unknown alert type '${alertType}'. ` +
            `Valid types: ${VALID_ALERT_TYPES.sort().join(", ")}. ` +
            "Use 'monitor_types' tool for details.",
        );
      }

      if (interval !== undefined && interval < 5) interval = 5;

      const cmdName = CMD_NAMES[alertType] ?? alertType;
      const parts = ["revx monitor", cmdName, pair];

      switch (alertType) {
        case "price": {
          const d = (direction ?? "").trim().toLowerCase();
          if (!PRICE_DIRECTIONS.has(d)) {
            return textResult(
              "For price alerts, direction must be 'above' or 'below'.",
            );
          }
          if (!threshold)
            return textResult("threshold is required for price alerts.");
          if (isNaN(Number(threshold))) {
            return textResult(
              `Invalid threshold: '${threshold}'. Must be a number.`,
            );
          }
          parts.push("--direction", d, "--threshold", threshold);
          break;
        }
        case "rsi": {
          if (direction) {
            const d = direction.trim().toLowerCase();
            if (!PRICE_DIRECTIONS.has(d))
              return textResult(
                `Invalid direction '${d}'. Valid: above, below.`,
              );
            parts.push("--direction", d);
          }
          if (threshold) parts.push("--threshold", threshold);
          if (period !== undefined) parts.push("--period", String(period));
          break;
        }
        case "ema_cross": {
          if (direction) {
            const d = direction.trim().toLowerCase();
            if (d !== "bullish" && d !== "bearish")
              return textResult(
                `Invalid direction '${d}'. Valid: bullish, bearish.`,
              );
            parts.push("--direction", d);
          }
          if (fast_period !== undefined)
            parts.push("--fast-period", String(fast_period));
          if (slow_period !== undefined)
            parts.push("--slow-period", String(slow_period));
          break;
        }
        case "macd": {
          if (direction) {
            const d = direction.trim().toLowerCase();
            if (d !== "bullish" && d !== "bearish")
              return textResult(
                `Invalid direction '${d}'. Valid: bullish, bearish.`,
              );
            parts.push("--direction", d);
          }
          if (fast !== undefined) parts.push("--fast", String(fast));
          if (slow !== undefined) parts.push("--slow", String(slow));
          if (signal !== undefined) parts.push("--signal", String(signal));
          break;
        }
        case "bollinger": {
          if (band) {
            const b = band.trim().toLowerCase();
            if (b !== "upper" && b !== "lower")
              return textResult(`Invalid band '${b}'. Valid: upper, lower.`);
            parts.push("--band", b);
          }
          if (period !== undefined) parts.push("--period", String(period));
          if (std_mult !== undefined)
            parts.push("--std-mult", String(std_mult));
          break;
        }
        case "volume_spike": {
          if (period !== undefined) parts.push("--period", String(period));
          if (multiplier !== undefined)
            parts.push("--multiplier", String(multiplier));
          break;
        }
        case "spread":
        case "obi": {
          if (direction) {
            const d = direction.trim().toLowerCase();
            if (!PRICE_DIRECTIONS.has(d))
              return textResult(
                `Invalid direction '${d}'. Valid: above, below.`,
              );
            parts.push("--direction", d);
          }
          if (threshold) parts.push("--threshold", threshold);
          break;
        }
        case "price_change_pct": {
          if (direction) {
            const d = direction.trim().toLowerCase();
            if (d !== "rise" && d !== "fall")
              return textResult(`Invalid direction '${d}'. Valid: rise, fall.`);
            parts.push("--direction", d);
          }
          if (threshold) parts.push("--threshold", threshold);
          if (lookback !== undefined)
            parts.push("--lookback", String(lookback));
          break;
        }
        case "atr_breakout": {
          if (period !== undefined) parts.push("--period", String(period));
          if (multiplier !== undefined)
            parts.push("--multiplier", String(multiplier));
          break;
        }
      }

      if (interval !== undefined) parts.push("--interval", String(interval));

      const effectiveInterval = interval ?? 10;
      const cmd = parts.join(" ");
      return textResult(
        `Command:\n  ${cmd}\n\n` +
          `This starts a foreground monitor that checks ${pair} every ${effectiveInterval}s.\n` +
          "Press Ctrl+C to stop. Telegram notifications are sent when the condition triggers." +
          CLI_INSTALL_HINT,
      );
    },
  );

  server.registerTool(
    "monitor_types",
    {
      title: "List Monitor Types",
      description:
        "List all supported monitor types for the 'revx monitor' CLI command. " +
        "Returns each type with description, config fields, and CLI usage example.",
      annotations: {
        title: "List Monitor Types",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async () => {
      const lines = ["Supported Monitor Types", "=".repeat(60), ""];
      for (const typeName of Object.keys(_ALERT_TYPE_DOCS).sort()) {
        const doc = _ALERT_TYPE_DOCS[typeName];
        lines.push(`  ${typeName}`);
        lines.push(`    ${doc.description}`);
        lines.push(`    Flags: ${doc.config_fields}`);
        lines.push(`    Example: ${doc.example}`);
        lines.push("");
      }
      lines.push("=".repeat(60));
      lines.push(
        `Total: ${Object.keys(_ALERT_TYPE_DOCS).length} monitor types`,
      );
      lines.push("");
      lines.push("CLI equivalent: revx monitor types");
      return textResult(lines.join("\n") + CLI_INSTALL_HINT);
    },
  );
}
