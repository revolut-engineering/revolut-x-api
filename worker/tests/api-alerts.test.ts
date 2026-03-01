import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers.js";
import { AlertRepo } from "../src/db/repositories.js";

let app: FastifyInstance;
let db: Database.Database;

beforeEach(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterEach(async () => {
  await app.close();
  db.close();
});

// ── Alert Types ──

describe("GET /api/alerts/types", () => {
  it("returns 10 alert types", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/alerts/types" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.data).toHaveLength(10);
  });

  it("each type has required fields", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/alerts/types" });
    const body = resp.json();
    for (const t of body.data) {
      expect(t.name).toBeDefined();
      expect(t.description).toBeDefined();
      expect(t.config_fields).toBeDefined();
      expect(t.example_config).toBeDefined();
    }
  });

  it("includes all 10 known types", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/alerts/types" });
    const names = resp.json().data.map((t: any) => t.name);
    expect(names).toContain("price");
    expect(names).toContain("rsi");
    expect(names).toContain("ema_cross");
    expect(names).toContain("macd");
    expect(names).toContain("bollinger");
    expect(names).toContain("volume_spike");
    expect(names).toContain("spread");
    expect(names).toContain("obi");
    expect(names).toContain("price_change_pct");
    expect(names).toContain("atr_breakout");
  });
});

// ── Create Alert ──

describe("POST /api/alerts", () => {
  it("creates an alert and returns 201", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "price",
        config: { direction: "above", threshold: "100000" },
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json();
    expect(body.id).toBeDefined();
    expect(body.pair).toBe("BTC-USD");
    expect(body.alert_type).toBe("price");
    expect(body.enabled).toBe(true);
    expect(body.triggered).toBe(false);
    expect(body.config.direction).toBe("above");
  });

  it("returns 422 for lowercase pair", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "btc-usd",
        alert_type: "price",
        config: {},
      },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("returns 422 for invalid alert type", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "invalid_type",
        config: {},
      },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("respects poll_interval_sec", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "rsi",
        config: { direction: "above", threshold: "70" },
        poll_interval_sec: 30,
      },
    });
    expect(resp.statusCode).toBe(201);
    expect(resp.json().poll_interval_sec).toBe(30);
  });

  it("returns 422 for poll_interval_sec < 5", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "price",
        config: {},
        poll_interval_sec: 2,
      },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("supports connection_ids", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "price",
        config: {},
        connection_ids: ["id1", "id2"],
      },
    });
    expect(resp.statusCode).toBe(201);
    expect(resp.json().connection_ids).toEqual(["id1", "id2"]);
  });

  it("null connection_ids means all connections", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: {
        pair: "BTC-USD",
        alert_type: "price",
        config: {},
        connection_ids: null,
      },
    });
    expect(resp.statusCode).toBe(201);
    expect(resp.json().connection_ids).toBeNull();
  });
});

// ── List Alerts ──

describe("GET /api/alerts", () => {
  it("returns empty list initially", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns created alerts", async () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    const resp = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(resp.json().data).toHaveLength(1);
    expect(resp.json().total).toBe(1);
  });

  it("filters by enabled", async () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    const a2 = AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    AlertRepo.update(db, a2.id as string, { enabled: 0 });

    const resp = await app.inject({
      method: "GET",
      url: "/api/alerts?enabled=true",
    });
    expect(resp.json().data).toHaveLength(1);
    expect(resp.json().total).toBe(1);
  });

  it("filters by alert_type", async () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");

    const resp = await app.inject({
      method: "GET",
      url: "/api/alerts?alert_type=rsi",
    });
    expect(resp.json().data).toHaveLength(1);
  });

  it("filters by pair", async () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");

    const resp = await app.inject({
      method: "GET",
      url: "/api/alerts?pair=BTC-USD",
    });
    expect(resp.json().data).toHaveLength(1);
  });

  it("supports pagination", async () => {
    for (let i = 0; i < 5; i++) {
      AlertRepo.create(db, "BTC-USD", "price", "{}");
    }
    const resp = await app.inject({
      method: "GET",
      url: "/api/alerts?limit=2&offset=0",
    });
    expect(resp.json().data).toHaveLength(2);
    expect(resp.json().total).toBe(5);
    expect(resp.json().limit).toBe(2);
    expect(resp.json().offset).toBe(0);
  });
});

// ── Get Alert ──

describe("GET /api/alerts/:id", () => {
  it("returns alert by id", async () => {
    const alert = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const resp = await app.inject({
      method: "GET",
      url: `/api/alerts/${alert.id}`,
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().id).toBe(alert.id);
  });

  it("returns 404 for missing id", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/api/alerts/nonexistent",
    });
    expect(resp.statusCode).toBe(404);
  });
});

// ── Update Alert ──

describe("PATCH /api/alerts/:id", () => {
  it("updates enabled flag", async () => {
    const alert = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/alerts/${alert.id}`,
      payload: { enabled: false },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().enabled).toBe(false);
  });

  it("returns 404 for missing id", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/alerts/nonexistent",
      payload: { enabled: false },
    });
    expect(resp.statusCode).toBe(404);
  });

  it("returns 200 with no changes for empty body", async () => {
    const alert = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/alerts/${alert.id}`,
      payload: {},
    });
    expect(resp.statusCode).toBe(200);
  });

  it("returns 404 with no changes for missing id", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/alerts/nonexistent",
      payload: {},
    });
    expect(resp.statusCode).toBe(404);
  });
});

// ── Delete Alert ──

describe("DELETE /api/alerts/:id", () => {
  it("returns 204 on success", async () => {
    const alert = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const resp = await app.inject({
      method: "DELETE",
      url: `/api/alerts/${alert.id}`,
    });
    expect(resp.statusCode).toBe(204);
  });

  it("returns 404 for missing id", async () => {
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/alerts/nonexistent",
    });
    expect(resp.statusCode).toBe(404);
  });
});
