import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers.js";

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

// ── Health ──

describe("GET /health", () => {
  it("returns health status", async () => {
    const resp = await app.inject({ method: "GET", url: "/health" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBeDefined();
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.version).toBe("0.1.0");
    expect(typeof body.worker_running).toBe("boolean");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.credentials_configured).toBe("boolean");
  });
});

// ── Worker Status ──

describe("GET /api/worker/status", () => {
  it("returns worker status", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/worker/status" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(typeof body.running).toBe("boolean");
    expect(body.status).toBe("running");
    expect(body.tick_interval_sec).toBe(10);
    expect(typeof body.active_alert_count).toBe("number");
    expect(typeof body.enabled_connection_count).toBe("number");
    expect(typeof body.credentials_configured).toBe("boolean");
  });
});

// ── Worker Restart ──

describe("POST /api/worker/restart", () => {
  it("returns ok status", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/worker/restart",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBe("ok");
    expect(body.message).toContain("restart");
  });
});

// ── Worker Stop ──

describe("POST /api/worker/stop", () => {
  it("returns ok status", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/worker/stop",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.status).toBe("ok");
    expect(body.message).toContain("stop");
  });
});

// ── Worker Settings ──

describe("GET /api/worker/settings", () => {
  it("returns current settings", async () => {
    const resp = await app.inject({
      method: "GET",
      url: "/api/worker/settings",
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().tick_interval_sec).toBe(10);
  });
});

describe("PATCH /api/worker/settings", () => {
  it("updates tick interval", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/worker/settings",
      payload: { tick_interval_sec: 30 },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().tick_interval_sec).toBe(30);
  });

  it("returns 422 for tick_interval_sec > 300", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/worker/settings",
      payload: { tick_interval_sec: 999 },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("returns 422 for tick_interval_sec < 1", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/worker/settings",
      payload: { tick_interval_sec: 0 },
    });
    expect(resp.statusCode).toBe(422);
  });
});
