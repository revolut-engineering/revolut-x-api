/**
 * Alert management MCP tools — delegates to Worker service.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, validateSymbol } from "./_helpers.js";

const _ALERT_TYPE_DOCS: Record<
  string,
  { description: string; config_fields: string; example: string }
> = {
  price: {
    description:
      "Simple price threshold alert — triggers when price crosses above or below a level.",
    config_fields:
      "Uses direction and threshold parameters directly (no config needed).",
    example: "alert_create pair=BTC-USD direction=above threshold=100000",
  },
  rsi: {
    description:
      "Relative Strength Index — triggers when RSI crosses a threshold (overbought/oversold).",
    config_fields:
      'period (default 14), direction (above/below), threshold (e.g. 70 for overbought, 30 for oversold).',
    example:
      'alert_create pair=BTC-USD alert_type=rsi config=\'{"period":14,"direction":"above","threshold":"70"}\'',
  },
  ema_cross: {
    description:
      "EMA Crossover — triggers when fast EMA crosses above (bullish) or below (bearish) slow EMA.",
    config_fields:
      "fast_period (default 9), slow_period (default 21), direction (bullish/bearish).",
    example:
      'alert_create pair=BTC-USD alert_type=ema_cross config=\'{"fast_period":9,"slow_period":21,"direction":"bullish"}\'',
  },
  macd: {
    description:
      "MACD Crossover — triggers when MACD line crosses signal line.",
    config_fields:
      "fast (default 12), slow (default 26), signal (default 9), direction (bullish/bearish).",
    example:
      'alert_create pair=BTC-USD alert_type=macd config=\'{"fast":12,"slow":26,"signal":9,"direction":"bullish"}\'',
  },
  bollinger: {
    description:
      "Bollinger Bands — triggers when price touches or crosses upper/lower band.",
    config_fields: "period (default 20), std_mult (default 2), band (upper/lower).",
    example:
      'alert_create pair=BTC-USD alert_type=bollinger config=\'{"period":20,"std_mult":"2","band":"upper"}\'',
  },
  volume_spike: {
    description:
      "Volume Spike — triggers when current volume exceeds a multiple of the average.",
    config_fields: "period (default 20), multiplier (default 2.0).",
    example:
      'alert_create pair=BTC-USD alert_type=volume_spike config=\'{"period":20,"multiplier":"2.0"}\'',
  },
  spread: {
    description:
      "Bid-Ask Spread — triggers when spread percentage crosses a threshold.",
    config_fields:
      "direction (above/below), threshold (percentage, e.g. 0.5 for 0.5%).",
    example:
      'alert_create pair=BTC-USD alert_type=spread config=\'{"direction":"above","threshold":"0.5"}\'',
  },
  obi: {
    description:
      "Order Book Imbalance — triggers when buy/sell volume imbalance crosses a threshold.",
    config_fields:
      "direction (above/below), threshold (e.g. 0.3 for 30% imbalance).",
    example:
      'alert_create pair=BTC-USD alert_type=obi config=\'{"direction":"above","threshold":"0.3"}\'',
  },
  price_change_pct: {
    description:
      "Price Change % — triggers when price has risen or fallen by at least X% over the last N 1-hour candles. Use direction=rise to trigger on upward moves, direction=fall for downward moves; threshold is always a positive magnitude (e.g. 5 means a 5% move).",
    config_fields:
      "lookback (1h candle count, default 24), direction (rise/fall), threshold (min % change, always positive).",
    example:
      'alert_create pair=BTC-USD alert_type=price_change_pct config=\'{"lookback":24,"direction":"rise","threshold":"5.0"}\'',
  },
  atr_breakout: {
    description:
      "ATR Breakout — triggers when price moves more than a multiple of ATR from previous close.",
    config_fields: "period (default 14), multiplier (default 1.5).",
    example:
      'alert_create pair=BTC-USD alert_type=atr_breakout config=\'{"period":14,"multiplier":"1.5"}\'',
  },
};

export function registerAlertTools(server: McpServer): void {
  server.registerTool(
    "alert_create",
    {
      title: "Create Alert",
      description: "Create a market alert. Delegates to Worker service. Supports 10 alert types: price, rsi, ema_cross, macd, bollinger, volume_spike, spread, obi, price_change_pct, atr_breakout. Use 'alert_types' tool to see all types and their config options.",
      inputSchema: {
        pair: z.string().describe('Trading pair symbol, e.g. "BTC-USD".'),
        alert_type: z.string().default("price").describe('Alert type (default "price").'),
        config: z
          .string()
          .default("")
          .describe(
            'JSON config string for non-price alerts (e.g. \'{"period":14,"direction":"above","threshold":"70"}\').',
          ),
        direction: z
          .string()
          .default("above")
          .describe('For price alerts: "above" or "below". Ignored for other types.'),
        threshold: z
          .string()
          .default("0")
          .describe("For price alerts: price threshold. Ignored for other types."),
        poll_interval_sec: z
          .number()
          .default(10)
          .describe("How often to check in seconds (default 10, minimum 5)."),
        connection_ids: z
          .string()
          .optional()
          .describe(
            "Comma-separated Telegram connection IDs. Omit to alert all enabled connections.",
          ),
      },
      annotations: {
        title: "Create Alert",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ pair, alert_type, config, direction, threshold, poll_interval_sec, connection_ids }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      pair = pair.trim().toUpperCase();
      const symError = validateSymbol(pair);
      if (symError) return textResult(`Invalid pair format: '${pair}'. Expected e.g. 'BTC-USD'.`);

      alert_type = alert_type.trim().toLowerCase();
      if (!(alert_type in _ALERT_TYPE_DOCS)) {
        return textResult(
          `Unknown alert type '${alert_type}'. ` +
            `Valid types: ${Object.keys(_ALERT_TYPE_DOCS).sort().join(", ")}. ` +
            "Use 'alert_types' to see details.",
        );
      }

      poll_interval_sec = Math.max(5, poll_interval_sec);

      let configDict: Record<string, unknown>;
      if (alert_type === "price") {
        direction = direction.trim().toLowerCase();
        if (direction !== "above" && direction !== "below") {
          return textResult("direction must be 'above' or 'below'.");
        }
        if (isNaN(Number(threshold))) {
          return textResult(`Invalid threshold: '${threshold}'. Must be a number.`);
        }
        configDict = { direction, threshold };
      } else if (config) {
        try {
          configDict = JSON.parse(config);
          if (typeof configDict !== "object" || configDict === null || Array.isArray(configDict)) {
            return textResult("config must be a JSON object.");
          }
        } catch (exc) {
          return textResult(`Invalid config JSON: ${exc}`);
        }
      } else {
        return textResult(
          `alert_type '${alert_type}' requires a config parameter. ` +
            "Use 'alert_types' to see required fields.",
        );
      }

      let connectionIdsList: string[] | undefined;
      if (connection_ids) {
        connectionIdsList = connection_ids
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x);
      }

      const body: Record<string, unknown> = {
        pair,
        alert_type,
        config: configDict,
        poll_interval_sec,
      };
      if (connectionIdsList) {
        body.connection_ids = connectionIdsList;
      }

      try {
        const result = await getWorkerClient().createAlert(body);
        return textResult(
          `Alert created (id: ${(result as Record<string, unknown>).id})\n` +
            `  Type: ${alert_type}\n` +
            `  Pair: ${pair}\n` +
            `  Poll interval: ${poll_interval_sec}s`,
        );
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 422) return textResult(`Invalid alert configuration: ${error.message}`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_list",
    {
      title: "List Alerts",
      description: "List all configured alerts with their type and status.",
      annotations: { title: "List Alerts", readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const data = await getWorkerClient().listAlerts();
        const alerts = ((data as Record<string, unknown>).data ?? []) as Record<string, unknown>[];

        if (!alerts.length) {
          return textResult("No alerts configured. Use 'alert_create' to set one up.");
        }

        const lines: string[] = [];
        for (const a of alerts) {
          const status = a.enabled ? "enabled" : "disabled";
          const triggered = a.triggered ? "TRIGGERED" : "watching";
          lines.push(
            `  ID: ${a.id}\n` +
              `  Type: ${a.alert_type ?? "?"}\n` +
              `  Pair: ${a.pair ?? "?"}\n` +
              `  Status: ${status} | State: ${triggered}\n` +
              `  Config: ${JSON.stringify(a.config ?? {})}\n` +
              `  Poll interval: ${a.poll_interval_sec ?? "?"}s\n` +
              `  Current value: ${a.current_value ?? "N/A"}\n` +
              `  Last checked: ${a.last_checked_at ?? "never"}`,
          );
        }
        return textResult(`Alerts (${alerts.length}):\n\n` + lines.join("\n\n"));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) return textResult(`Worker error: ${error.message}`);
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_enable",
    {
      title: "Enable Alert",
      description: "Enable an alert.",
      inputSchema: {
        alert_id: z.string().describe("ID of the alert to enable."),
      },
      annotations: { title: "Enable Alert", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ alert_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().updateAlert(alert_id, { enabled: true });
        return textResult(`Alert ${alert_id} enabled.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Alert ${alert_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_disable",
    {
      title: "Disable Alert",
      description: "Disable an alert.",
      inputSchema: {
        alert_id: z.string().describe("ID of the alert to disable."),
      },
      annotations: { title: "Disable Alert", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ alert_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().updateAlert(alert_id, { enabled: false });
        return textResult(`Alert ${alert_id} disabled.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Alert ${alert_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_delete",
    {
      title: "Delete Alert",
      description: "Delete an alert.",
      inputSchema: {
        alert_id: z.string().describe("ID of the alert to delete."),
      },
      annotations: { title: "Delete Alert", readOnlyHint: false, destructiveHint: true },
    },
    async ({ alert_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().deleteAlert(alert_id);
        return textResult(`Alert ${alert_id} deleted.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Alert ${alert_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_get",
    {
      title: "Get Alert Details",
      description: "Get full details of a specific alert including config, current value, and timestamps.",
      inputSchema: {
        alert_id: z.string().describe("ID of the alert to retrieve."),
      },
      annotations: { title: "Get Alert Details", readOnlyHint: true, destructiveHint: false },
    },
    async ({ alert_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const a = (await getWorkerClient().getAlert(alert_id)) as Record<string, unknown>;
        const status = a.enabled ? "enabled" : "disabled";
        const triggered = a.triggered ? "TRIGGERED" : "watching";
        const current = a.current_value as Record<string, string> | undefined;
        const currentStr = current
          ? `${current.label}: ${current.value}`
          : "N/A";

        return textResult(
          `Alert ${a.id}\n` +
            `  Type: ${a.alert_type ?? "?"}\n` +
            `  Pair: ${a.pair ?? "?"}\n` +
            `  Config: ${JSON.stringify(a.config ?? {})}\n` +
            `  Status: ${status} | State: ${triggered}\n` +
            `  Poll interval: ${a.poll_interval_sec ?? "?"}s\n` +
            `  Current value: ${currentStr}\n` +
            `  Connection IDs: ${a.connection_ids ?? "all"}\n` +
            `  Last checked: ${a.last_checked_at ?? "never"}\n` +
            `  Last triggered: ${a.last_triggered_at ?? "never"}\n` +
            `  Created: ${a.created_at ?? "?"}\n` +
            `  Updated: ${a.updated_at ?? "?"}`,
        );
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Alert ${alert_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "alert_types",
    {
      title: "List Alert Types",
      description: "List all supported alert types with configuration options and examples. Returns documentation for each alert type including required config fields, defaults, and usage examples.",
      annotations: { title: "List Alert Types", readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const data = (await getWorkerClient().getAlertTypes()) as Record<string, unknown>;
        const types = (data.data ?? []) as Record<string, string>[];
        const lines = ["Supported Alert Types", "=".repeat(60), ""];
        for (const t of types) {
          lines.push(`  ${t.name}`);
          lines.push(`    ${t.description ?? ""}`);
          lines.push("");
        }
        lines.push(`Total: ${types.length} alert types`);
        return textResult(lines.join("\n"));
      } catch (error) {
        if (error instanceof WorkerAPIError) {
          return textResult(`Worker error: ${error.message}`);
        }
        if (error instanceof WorkerUnavailableError) {
          const lines = ["Supported Alert Types", "=".repeat(60), ""];
          for (const typeName of Object.keys(_ALERT_TYPE_DOCS).sort()) {
            const doc = _ALERT_TYPE_DOCS[typeName];
            lines.push(`  ${typeName}`);
            lines.push(`    ${doc.description}`);
            lines.push(`    Config: ${doc.config_fields}`);
            lines.push(`    Example: ${doc.example}`);
            lines.push("");
          }
          lines.push("=".repeat(60));
          lines.push(`Total: ${Object.keys(_ALERT_TYPE_DOCS).length} alert types`);
          lines.push("");
          lines.push(`(Worker offline — showing cached docs)\n${WORKER_NOT_RUNNING}`);
          return textResult(lines.join("\n"));
        }
        throw error;
      }
    },
  );
}
