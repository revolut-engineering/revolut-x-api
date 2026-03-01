import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers.js";
import { EventRepo } from "../src/db/repositories.js";

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

describe("GET /api/events", () => {
  it("returns empty list initially", async () => {
    const resp = await app.inject({ method: "GET", url: "/api/events" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns events with parsed details", async () => {
    EventRepo.append(db, "alert_triggered", { pair: "BTC-USD" });
    const resp = await app.inject({ method: "GET", url: "/api/events" });
    const body = resp.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].category).toBe("alert_triggered");
    expect(body.data[0].details.pair).toBe("BTC-USD");
    expect(body.data[0].ts).toBeDefined();
    expect(body.total).toBe(1);
  });

  it("filters by category", async () => {
    EventRepo.append(db, "alert_triggered", {});
    EventRepo.append(db, "worker_started", {});
    const resp = await app.inject({
      method: "GET",
      url: "/api/events?category=alert_triggered",
    });
    expect(resp.json().data).toHaveLength(1);
    expect(resp.json().total).toBe(1);
  });

  it("supports pagination", async () => {
    for (let i = 0; i < 5; i++) {
      EventRepo.append(db, "event", { i });
    }
    const resp = await app.inject({
      method: "GET",
      url: "/api/events?limit=2&offset=0",
    });
    expect(resp.json().data).toHaveLength(2);
    expect(resp.json().total).toBe(5);
    expect(resp.json().limit).toBe(2);
  });

  it("returns empty details for events without details_json", async () => {
    EventRepo.append(db, "bare_event");
    const resp = await app.inject({ method: "GET", url: "/api/events" });
    expect(resp.json().data[0].details).toEqual({});
  });
});
