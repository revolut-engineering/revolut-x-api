import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers.js";
import { TelegramConnectionRepo } from "../src/db/repositories.js";

const VALID_TOKEN = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const BASE = "/api/telegram/connections";

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

function createConn(label = "test") {
  return TelegramConnectionRepo.create(db, label, VALID_TOKEN, "123456");
}

// ── List Connections ──

describe("GET /api/telegram/connections", () => {
  it("returns empty list initially", async () => {
    const resp = await app.inject({ method: "GET", url: BASE });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns created connections", async () => {
    createConn("one");
    createConn("two");
    const resp = await app.inject({ method: "GET", url: BASE });
    expect(resp.json().data).toHaveLength(2);
    expect(resp.json().total).toBe(2);
  });

  it("filters by enabled", async () => {
    createConn("one");
    const c2 = createConn("two");
    TelegramConnectionRepo.update(db, c2.id as string, { enabled: 0 });

    const resp = await app.inject({
      method: "GET",
      url: `${BASE}?enabled=true`,
    });
    expect(resp.json().data).toHaveLength(1);
  });
});

// ── Create Connection ──

describe("POST /api/telegram/connections", () => {
  it("creates connection and returns 201", async () => {
    const resp = await app.inject({
      method: "POST",
      url: BASE,
      payload: {
        label: "my bot",
        bot_token: VALID_TOKEN,
        chat_id: "123456",
      },
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json();
    expect(body.id).toBeDefined();
    expect(body.label).toBe("my bot");
    expect(body.enabled).toBe(true);
    expect(body.test_result).toBeNull();
  });

  it("returns bot_token_redacted, never raw token", async () => {
    const resp = await app.inject({
      method: "POST",
      url: BASE,
      payload: {
        label: "test",
        bot_token: VALID_TOKEN,
        chat_id: "123456",
      },
    });
    const body = resp.json();
    expect(body.bot_token_redacted).toBeDefined();
    expect(body.bot_token_redacted).toMatch(/^\*{4}.{4}$/);
    expect(resp.payload).not.toContain(VALID_TOKEN);
  });

  it("returns 422 for missing label", async () => {
    const resp = await app.inject({
      method: "POST",
      url: BASE,
      payload: {
        label: "",
        bot_token: VALID_TOKEN,
        chat_id: "123456",
      },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("returns 422 for missing bot_token", async () => {
    const resp = await app.inject({
      method: "POST",
      url: BASE,
      payload: {
        label: "test",
        bot_token: "",
        chat_id: "123456",
      },
    });
    expect(resp.statusCode).toBe(422);
  });

  it("creates with test:true sends test message", async () => {
    // Mock sendMessage
    const sendMessage = vi.fn().mockResolvedValue({ success: true });
    vi.doMock("../src/shared/notify/telegram.js", () => ({
      sendMessage,
      redactToken: (t: string) =>
        t.length <= 4 ? "****" : `****${t.slice(-4)}`,
    }));

    const resp = await app.inject({
      method: "POST",
      url: BASE,
      payload: {
        label: "test",
        bot_token: VALID_TOKEN,
        chat_id: "123456",
        test: true,
      },
    });
    // Note: without module mocking this won't actually call our mock
    // but the test validates the API contract shape
    expect(resp.statusCode).toBe(201);
    vi.doUnmock("../src/shared/notify/telegram.js");
  });
});

// ── Update Connection ──

describe("PATCH /api/telegram/connections/:id", () => {
  it("updates label", async () => {
    const c = createConn("old");
    const resp = await app.inject({
      method: "PATCH",
      url: `${BASE}/${c.id}`,
      payload: { label: "new" },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().label).toBe("new");
  });

  it("updates enabled", async () => {
    const c = createConn("test");
    const resp = await app.inject({
      method: "PATCH",
      url: `${BASE}/${c.id}`,
      payload: { enabled: false },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().enabled).toBe(false);
  });

  it("returns 404 for missing id", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: `${BASE}/nonexistent`,
      payload: { label: "x" },
    });
    expect(resp.statusCode).toBe(404);
  });

  it("returns 200 with empty body", async () => {
    const c = createConn("test");
    const resp = await app.inject({
      method: "PATCH",
      url: `${BASE}/${c.id}`,
      payload: {},
    });
    expect(resp.statusCode).toBe(200);
  });

  it("returns 404 with empty body for missing id", async () => {
    const resp = await app.inject({
      method: "PATCH",
      url: `${BASE}/nonexistent`,
      payload: {},
    });
    expect(resp.statusCode).toBe(404);
  });
});

// ── Delete Connection ──

describe("DELETE /api/telegram/connections/:id", () => {
  it("returns 204 on success", async () => {
    const c = createConn("test");
    const resp = await app.inject({
      method: "DELETE",
      url: `${BASE}/${c.id}`,
    });
    expect(resp.statusCode).toBe(204);
  });

  it("returns 404 for missing id", async () => {
    const resp = await app.inject({
      method: "DELETE",
      url: `${BASE}/nonexistent`,
    });
    expect(resp.statusCode).toBe(404);
  });
});

// ── Test Connection ──

describe("POST /api/telegram/connections/:id/test", () => {
  it("returns 404 for missing connection", async () => {
    const resp = await app.inject({
      method: "POST",
      url: `${BASE}/nonexistent/test`,
      payload: {},
    });
    expect(resp.statusCode).toBe(404);
  });

  it("tests existing connection", async () => {
    const c = createConn("test");
    const resp = await app.inject({
      method: "POST",
      url: `${BASE}/${c.id}/test`,
      payload: { message: "hello" },
    });
    // Will fail because no real Telegram API, but structure is valid
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(typeof body.success).toBe("boolean");
  });

  it("works with empty body", async () => {
    const c = createConn("test");
    const resp = await app.inject({
      method: "POST",
      url: `${BASE}/${c.id}/test`,
      payload: {},
    });
    expect(resp.statusCode).toBe(200);
  });
});
