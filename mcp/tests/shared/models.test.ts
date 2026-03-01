import { describe, it, expect } from "vitest";
import {
  AlertCreateSchema,
  AlertUpdateSchema,
} from "../../src/shared/models/alerts.js";
import {
  ConnectionCreateSchema,
  ConnectionResponseSchema,
  ConnectionUpdateSchema,
} from "../../src/shared/models/telegram.js";
import {
  EventResponseSchema,
  EventListResponseSchema,
} from "../../src/shared/models/events.js";
import {
  WorkerStatusSchema,
  HealthResponseSchema,
} from "../../src/shared/models/worker.js";
import { RevolutXConfigSchema } from "../../src/shared/models/config.js";

// ── AlertCreate ──

describe("AlertCreate", () => {
  it("valid BTC-USD", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTC-USD", alert_type: "price" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pair).toBe("BTC-USD");
  });

  it("valid ETH-BTC", () => {
    const result = AlertCreateSchema.safeParse({ pair: "ETH-BTC", alert_type: "rsi" });
    expect(result.success).toBe(true);
  });

  it("invalid lowercase pair", () => {
    const result = AlertCreateSchema.safeParse({ pair: "btc-usd", alert_type: "price" });
    expect(result.success).toBe(false);
  });

  it("invalid slash pair", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTC/USD", alert_type: "price" });
    expect(result.success).toBe(false);
  });

  it("invalid no-dash pair", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTCUSD", alert_type: "price" });
    expect(result.success).toBe(false);
  });

  it("invalid alert_type", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTC-USD", alert_type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("poll_interval_sec too small", () => {
    const result = AlertCreateSchema.safeParse({
      pair: "BTC-USD",
      alert_type: "price",
      poll_interval_sec: 4,
    });
    expect(result.success).toBe(false);
  });

  it("poll_interval_sec minimum (5)", () => {
    const result = AlertCreateSchema.safeParse({
      pair: "BTC-USD",
      alert_type: "price",
      poll_interval_sec: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.poll_interval_sec).toBe(5);
  });

  it("poll_interval_sec default is 10", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTC-USD", alert_type: "price" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.poll_interval_sec).toBe(10);
  });

  it("connection_ids defaults to undefined", () => {
    const result = AlertCreateSchema.safeParse({ pair: "BTC-USD", alert_type: "price" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.connection_ids).toBeUndefined();
  });

  it("connection_ids accepts list", () => {
    const result = AlertCreateSchema.safeParse({
      pair: "BTC-USD",
      alert_type: "price",
      connection_ids: ["conn-1", "conn-2"],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.connection_ids).toHaveLength(2);
  });

  it("all alert types are valid", () => {
    const validTypes = [
      "price", "rsi", "ema_cross", "macd", "bollinger",
      "volume_spike", "spread", "obi", "price_change_pct", "atr_breakout",
    ];
    for (const t of validTypes) {
      const result = AlertCreateSchema.safeParse({ pair: "BTC-USD", alert_type: t });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.alert_type).toBe(t);
    }
  });
});

// ── AlertUpdate ──

describe("AlertUpdate", () => {
  it("empty body is valid", () => {
    const result = AlertUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBeUndefined();
      expect(result.data.poll_interval_sec).toBeUndefined();
      expect(result.data.connection_ids).toBeUndefined();
    }
  });

  it("enable only", () => {
    const result = AlertUpdateSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(true);
  });

  it("poll_interval_sec too small", () => {
    const result = AlertUpdateSchema.safeParse({ poll_interval_sec: 4 });
    expect(result.success).toBe(false);
  });

  it("poll_interval_sec minimum (5)", () => {
    const result = AlertUpdateSchema.safeParse({ poll_interval_sec: 5 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.poll_interval_sec).toBe(5);
  });
});

// ── ConnectionCreate ──

describe("ConnectionCreate", () => {
  it("valid connection", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "My Bot",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.test).toBe(false);
  });

  it("empty bot_token rejected", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "",
      chat_id: "12345",
      label: "My Bot",
    });
    expect(result.success).toBe(false);
  });

  it("empty chat_id rejected", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "",
      label: "My Bot",
    });
    expect(result.success).toBe(false);
  });

  it("empty label rejected", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "",
    });
    expect(result.success).toBe(false);
  });

  it("label too long rejected", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "x".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  it("label max length accepted", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "x".repeat(128),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.label).toHaveLength(128);
  });

  it("test defaults to false", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "Label",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.test).toBe(false);
  });

  it("test true accepted", () => {
    const result = ConnectionCreateSchema.safeParse({
      bot_token: "abc123",
      chat_id: "12345",
      label: "Label",
      test: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.test).toBe(true);
  });
});

// ── ConnectionUpdate ──

describe("ConnectionUpdate", () => {
  it("empty body is valid", () => {
    const result = ConnectionUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBeUndefined();
      expect(result.data.label).toBeUndefined();
    }
  });

  it("enable only", () => {
    const result = ConnectionUpdateSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(false);
  });

  it("empty label rejected", () => {
    const result = ConnectionUpdateSchema.safeParse({ label: "" });
    expect(result.success).toBe(false);
  });
});

// ── ConnectionResponse ──

describe("ConnectionResponse", () => {
  const now = new Date().toISOString();

  it("no bot_token field in schema", () => {
    const shape = ConnectionResponseSchema.shape;
    expect("bot_token" in shape).toBe(false);
  });

  it("bot_token_redacted present in schema", () => {
    const shape = ConnectionResponseSchema.shape;
    expect("bot_token_redacted" in shape).toBe(true);
  });

  it("valid instantiation", () => {
    const result = ConnectionResponseSchema.safeParse({
      id: "conn-1",
      label: "Test",
      bot_token_redacted: "****abcd",
      chat_id: "12345",
      enabled: true,
      last_tested_at: null,
      last_test_error: null,
      created_at: now,
      updated_at: now,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.bot_token_redacted).toBe("****abcd");
  });
});

// ── WorkerStatus ──

describe("WorkerStatus", () => {
  it("valid running status", () => {
    const result = WorkerStatusSchema.safeParse({
      running: true,
      status: "running",
      last_tick: null,
      last_error: null,
      active_alert_count: 5,
      enabled_connection_count: 2,
      tick_interval_sec: 30,
      uptime_seconds: 120.5,
      credentials_configured: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("running");
      expect(result.data.credentials_configured).toBe(true);
    }
  });

  it("valid stopped status", () => {
    const result = WorkerStatusSchema.safeParse({
      running: false,
      status: "stopped",
      last_tick: null,
      last_error: null,
      active_alert_count: 0,
      enabled_connection_count: 0,
      tick_interval_sec: 30,
      uptime_seconds: null,
      credentials_configured: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.uptime_seconds).toBeNull();
  });

  it("invalid status value rejected", () => {
    const result = WorkerStatusSchema.safeParse({
      running: false,
      status: "unknown",
      last_tick: null,
      last_error: null,
      active_alert_count: 0,
      enabled_connection_count: 0,
      tick_interval_sec: 30,
      uptime_seconds: null,
      credentials_configured: false,
    });
    expect(result.success).toBe(false);
  });

  it("uptime_seconds null is valid", () => {
    const result = WorkerStatusSchema.safeParse({
      running: false,
      status: "stopped",
      last_tick: null,
      last_error: null,
      active_alert_count: 0,
      enabled_connection_count: 0,
      tick_interval_sec: 30,
      uptime_seconds: null,
      credentials_configured: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.uptime_seconds).toBeNull();
  });
});

// ── HealthResponse ──

describe("HealthResponse", () => {
  it("valid healthy", () => {
    const result = HealthResponseSchema.safeParse({
      status: "healthy",
      version: "0.1.0",
      worker_running: true,
      uptime_seconds: 100.0,
      active_alerts: 3,
      enabled_connections: 1,
      credentials_configured: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("healthy");
      expect(result.data.credentials_configured).toBe(true);
    }
  });

  it("valid degraded", () => {
    const result = HealthResponseSchema.safeParse({
      status: "degraded",
      version: "0.1.0",
      worker_running: false,
      uptime_seconds: 0.0,
      active_alerts: 0,
      enabled_connections: 0,
      credentials_configured: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe("degraded");
  });

  it("invalid status 'ok' rejected", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      version: "0.1.0",
      worker_running: true,
      uptime_seconds: 100.0,
      active_alerts: 0,
      enabled_connections: 0,
      credentials_configured: false,
    });
    expect(result.success).toBe(false);
  });
});

// ── EventResponse ──

describe("EventResponse", () => {
  const now = new Date().toISOString();

  it("valid event", () => {
    const result = EventResponseSchema.safeParse({
      id: "evt-1",
      ts: now,
      category: "alert_triggered",
      details: { pair: "BTC-USD", alert_id: "abc" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe("alert_triggered");
  });

  it("category is plain string (future categories work)", () => {
    const result = EventResponseSchema.safeParse({
      id: "evt-2",
      ts: now,
      category: "some_future_category",
      details: {},
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe("some_future_category");
  });
});

// ── EventListResponse ──

describe("EventListResponse", () => {
  it("empty list", () => {
    const result = EventListResponseSchema.safeParse({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total).toBe(0);
      expect(result.data.data).toEqual([]);
    }
  });
});

// ── RevolutXConfig ──

describe("RevolutXConfig", () => {
  it("defaults to empty strings", () => {
    const result = RevolutXConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.api_key).toBe("");
      expect(result.data.private_key_path).toBe("");
    }
  });

  it("valid 64-char api_key", () => {
    const result = RevolutXConfigSchema.safeParse({ api_key: "a".repeat(64) });
    expect(result.success).toBe(true);
  });

  it("invalid short api_key", () => {
    const result = RevolutXConfigSchema.safeParse({ api_key: "short" });
    expect(result.success).toBe(false);
  });

  it("invalid non-alnum api_key", () => {
    const result = RevolutXConfigSchema.safeParse({ api_key: "!".repeat(64) });
    expect(result.success).toBe(false);
  });

  it("empty api_key is valid (not configured)", () => {
    const result = RevolutXConfigSchema.safeParse({ api_key: "" });
    expect(result.success).toBe(true);
  });
});
