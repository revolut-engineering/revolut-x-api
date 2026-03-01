import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AlertCreateSchema, AlertUpdateSchema } from "../shared/models/alerts.js";
import type {
  AlertTypeInfo,
  AlertTypeConfigField,
  CurrentValue,
} from "../shared/models/alerts.js";
import { AlertRepo } from "../db/repositories.js";

const ALERT_TYPES: AlertTypeInfo[] = [
  {
    name: "price",
    description: "Trigger when price crosses a threshold",
    config_fields: [
      { name: "direction", type: "string", required: true, enum: ["above", "below"], description: "Price direction relative to threshold" },
      { name: "threshold", type: "string", required: true, description: "Price level as decimal string" },
    ],
    example_config: { direction: "above", threshold: "100000" },
  },
  {
    name: "rsi",
    description: "Trigger when RSI crosses a threshold",
    config_fields: [
      { name: "period", type: "integer", required: false, default: 14, description: "RSI calculation period in 1-hour candles" },
      { name: "direction", type: "string", required: true, enum: ["above", "below"] },
      { name: "threshold", type: "string", required: true, description: "RSI level (0-100)" },
    ],
    example_config: { period: 14, direction: "above", threshold: "70" },
  },
  {
    name: "ema_cross",
    description: "Trigger on EMA crossover",
    config_fields: [
      { name: "fast_period", type: "integer", required: false, default: 9, description: "Fast EMA period in 1-hour candles" },
      { name: "slow_period", type: "integer", required: false, default: 21, description: "Slow EMA period in 1-hour candles" },
      { name: "direction", type: "string", required: true, enum: ["bullish", "bearish"], description: "bullish = fast > slow" },
    ],
    example_config: { fast_period: 9, slow_period: 21, direction: "bullish" },
  },
  {
    name: "macd",
    description: "Trigger on MACD signal line crossover",
    config_fields: [
      { name: "fast", type: "integer", required: false, default: 12, description: "Fast EMA period in 1-hour candles" },
      { name: "slow", type: "integer", required: false, default: 26, description: "Slow EMA period in 1-hour candles" },
      { name: "signal", type: "integer", required: false, default: 9, description: "Signal line smoothing period in 1-hour candles" },
      { name: "direction", type: "string", required: true, enum: ["bullish", "bearish"] },
    ],
    example_config: { fast: 12, slow: 26, signal: 9, direction: "bullish" },
  },
  {
    name: "bollinger",
    description: "Trigger when price crosses a Bollinger Band",
    config_fields: [
      { name: "period", type: "integer", required: false, default: 20, description: "Moving-average and std dev period in 1-hour candles" },
      { name: "std_mult", type: "string", required: false, default: "2", description: "Standard deviation multiplier" },
      { name: "band", type: "string", required: true, enum: ["upper", "lower"] },
    ],
    example_config: { period: 20, std_mult: "2", band: "upper" },
  },
  {
    name: "volume_spike",
    description: "Trigger when volume exceeds N times average",
    config_fields: [
      { name: "period", type: "integer", required: false, default: 20, description: "Average-volume baseline period in 1-hour candles" },
      { name: "multiplier", type: "string", required: false, default: "2", description: "Volume multiplier threshold" },
    ],
    example_config: { period: 20, multiplier: "2" },
  },
  {
    name: "spread",
    description: "Trigger when bid-ask spread percentage crosses a threshold",
    config_fields: [
      { name: "direction", type: "string", required: true, enum: ["above", "below"] },
      { name: "threshold", type: "string", required: true, description: "Spread percentage as decimal string" },
    ],
    example_config: { direction: "above", threshold: "0.5" },
  },
  {
    name: "obi",
    description: "Trigger based on Order Book Imbalance",
    config_fields: [
      { name: "direction", type: "string", required: true, enum: ["above", "below"] },
      { name: "threshold", type: "string", required: true, description: "OBI value (-1.0 to 1.0)" },
    ],
    example_config: { direction: "above", threshold: "0.3" },
  },
  {
    name: "price_change_pct",
    description: "Trigger when price has risen or fallen by at least X% over the last N 1-hour candles",
    config_fields: [
      { name: "lookback", type: "integer", required: false, default: 24, description: "Number of 1-hour candles to look back (e.g. 24 = last 24 hours)" },
      { name: "direction", type: "string", required: true, enum: ["rise", "fall"], description: "rise = trigger when price went up by >= threshold, fall = trigger when price went down by >= threshold" },
      { name: "threshold", type: "string", required: true, description: "Minimum absolute price change in % (always positive, e.g. 5 means a 5% move)" },
    ],
    example_config: { lookback: 24, direction: "rise", threshold: "5" },
  },
  {
    name: "atr_breakout",
    description: "Trigger when price move exceeds ATR * multiplier",
    config_fields: [
      { name: "period", type: "integer", required: false, default: 14, description: "ATR calculation period in 1-hour candles" },
      { name: "multiplier", type: "string", required: false, default: "1.5" },
    ],
    example_config: { period: 14, multiplier: "1.5" },
  },
];

function parseDatetime(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function rowToAlertResponse(row: Record<string, unknown>) {
  const configRaw = row.config_json as string | null;
  const config = configRaw ? JSON.parse(configRaw) : {};

  const connectionsRaw = row.connections_json as string | null;
  const connectionIds = connectionsRaw ? JSON.parse(connectionsRaw) : null;

  let currentValue: CurrentValue | null = null;
  const currentRaw = row.current_value_json as string | null;
  if (currentRaw) {
    try {
      const cv = JSON.parse(currentRaw);
      currentValue = { label: cv.label, value: cv.value };
    } catch {
      // ignore
    }
  }

  return {
    id: row.id,
    pair: row.pair,
    alert_type: row.alert_type,
    config,
    poll_interval_sec: row.poll_interval_sec,
    enabled: Boolean(row.enabled),
    triggered: Boolean(row.triggered ?? 0),
    connection_ids: connectionIds,
    last_checked_at: parseDatetime(row.last_checked_at),
    last_triggered_at: parseDatetime(row.last_triggered_at),
    created_at: parseDatetime(row.created_at),
    updated_at: parseDatetime(row.updated_at),
    current_value: currentValue,
  };
}

export function registerAlertRoutes(app: FastifyInstance): void {
  // IMPORTANT: /types must be registered before /:alert_id
  app.get("/api/alerts/types", async () => {
    return { data: ALERT_TYPES };
  });

  app.get("/api/alerts", async (request: FastifyRequest, _reply) => {
    const query = request.query as Record<string, string>;
    const enabled = query.enabled !== undefined
      ? query.enabled === "true"
      : undefined;
    const alertType = query.alert_type;
    const pair = query.pair;
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const rows = AlertRepo.listAll(app.db, {
      enabled,
      alertType,
      pair,
      limit,
      offset,
    });
    const total = AlertRepo.count(app.db, {
      enabled,
      alertType,
      pair,
    });

    return {
      data: rows.map(rowToAlertResponse),
      total,
      limit,
      offset,
    };
  });

  app.post("/api/alerts", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = AlertCreateSchema.safeParse(request.body);
    if (!parseResult.success) {
      const details = parseResult.error.errors.map((e) => ({
        loc: e.path,
        msg: e.message,
        type: e.code,
      }));
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: details[0]?.msg ?? "Validation failed",
          details,
        },
      });
    }

    const body = parseResult.data;

    // Pair validation (skip if credentials unavailable or API unreachable)
    const { loadCredentials } = await import("../shared/auth/credentials.js");
    const creds = loadCredentials();
    if (creds) {
      const pairs = await fetchPairsFromApi(creds);
      if (pairs !== null && !pairs.has(body.pair)) {
        return reply.status(422).send({
          error: {
            code: "VALIDATION_ERROR",
            message: `Unknown trading pair '${body.pair}'. Use the get_currency_pairs tool to see available pairs.`,
          },
        });
      }
    }

    const configJson = JSON.stringify(body.config);
    const connectionsJson = body.connection_ids
      ? JSON.stringify(body.connection_ids)
      : undefined;

    const row = AlertRepo.create(
      app.db,
      body.pair,
      body.alert_type,
      configJson,
      body.poll_interval_sec,
      connectionsJson,
    );

    return reply.status(201).send(rowToAlertResponse(row));
  });

  app.get("/api/alerts/:alertId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { alertId } = request.params as { alertId: string };
    const row = AlertRepo.get(app.db, alertId);
    if (!row) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `Alert '${alertId}' not found` },
      });
    }
    return rowToAlertResponse(row);
  });

  app.patch("/api/alerts/:alertId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { alertId } = request.params as { alertId: string };

    const parseResult = AlertUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      const details = parseResult.error.errors.map((e) => ({
        loc: e.path,
        msg: e.message,
        type: e.code,
      }));
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: details[0]?.msg ?? "Validation failed",
          details,
        },
      });
    }

    const body = parseResult.data;
    const updates: Record<string, unknown> = {};

    if (body.enabled !== undefined && body.enabled !== null) {
      updates.enabled = body.enabled ? 1 : 0;
    }
    if (body.poll_interval_sec !== undefined && body.poll_interval_sec !== null) {
      updates.poll_interval_sec = body.poll_interval_sec;
    }
    if (body.connection_ids !== undefined && body.connection_ids !== null) {
      updates.connections_json = JSON.stringify(body.connection_ids);
    }

    if (Object.keys(updates).length > 0) {
      const found = AlertRepo.update(app.db, alertId, updates);
      if (!found) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Alert '${alertId}' not found`,
          },
        });
      }
    } else {
      if (!AlertRepo.get(app.db, alertId)) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Alert '${alertId}' not found`,
          },
        });
      }
    }

    const row = AlertRepo.get(app.db, alertId)!;
    return rowToAlertResponse(row);
  });

  app.delete("/api/alerts/:alertId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { alertId } = request.params as { alertId: string };
    const found = AlertRepo.delete(app.db, alertId);
    if (!found) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `Alert '${alertId}' not found` },
      });
    }
    return reply.status(204).send();
  });
}

// Pairs fetching helper (used by alert creation and pairs endpoint)
import type { Credentials } from "../shared/auth/credentials.js";
import { buildAuthHeaders } from "../shared/auth/signer.js";

const API_BASE = "https://revx.revolut.com";
const TICKERS_PATH = "/api/1.0/tickers";

export async function fetchPairsFromApi(
  creds: Credentials,
): Promise<Set<string> | null> {
  const headers = buildAuthHeaders(
    creds.apiKey,
    creds.privateKey,
    "GET",
    TICKERS_PATH,
  );
  try {
    const response = await fetch(`${API_BASE}${TICKERS_PATH}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const tickers = Array.isArray(data)
      ? data
      : (data as Record<string, unknown>).data
        ? ((data as Record<string, unknown>).data as unknown[])
        : [];
    const pairs = new Set<string>();
    for (const t of tickers as Record<string, unknown>[]) {
      const symbol = t.symbol as string | undefined;
      if (symbol) pairs.add(String(symbol).replace("/", "-"));
    }
    return pairs.size > 0 ? pairs : null;
  } catch {
    return null;
  }
}
