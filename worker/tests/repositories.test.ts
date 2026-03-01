import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/schema.js";
import {
  TelegramConnectionRepo,
  AlertRepo,
  EventRepo,
  HeartbeatRepo,
} from "../src/db/repositories.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

afterEach(() => {
  db.close();
});

// ── TelegramConnectionRepo ──

describe("TelegramConnectionRepo", () => {
  const TOKEN = "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  const CHAT_ID = "123456";

  it("create returns a row with id and fields", () => {
    const row = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    expect(row.id).toBeDefined();
    expect(row.label).toBe("test");
    expect(row.bot_token).toBe(TOKEN);
    expect(row.chat_id).toBe(CHAT_ID);
    expect(row.enabled).toBe(1);
    expect(row.created_at).toBeDefined();
    expect(row.updated_at).toBeDefined();
  });

  it("get returns a row by id", () => {
    const created = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    const row = TelegramConnectionRepo.get(db, created.id as string);
    expect(row).toBeDefined();
    expect(row!.id).toBe(created.id);
  });

  it("get returns undefined for missing id", () => {
    const row = TelegramConnectionRepo.get(db, "nonexistent");
    expect(row).toBeUndefined();
  });

  it("listAll returns all connections", () => {
    TelegramConnectionRepo.create(db, "one", TOKEN, CHAT_ID);
    TelegramConnectionRepo.create(db, "two", TOKEN, CHAT_ID);
    const rows = TelegramConnectionRepo.listAll(db);
    expect(rows).toHaveLength(2);
  });

  it("listAll filters by enabled", () => {
    TelegramConnectionRepo.create(db, "one", TOKEN, CHAT_ID);
    const c2 = TelegramConnectionRepo.create(db, "two", TOKEN, CHAT_ID);
    TelegramConnectionRepo.update(db, c2.id as string, { enabled: 0 });
    expect(TelegramConnectionRepo.listAll(db, true)).toHaveLength(1);
    expect(TelegramConnectionRepo.listAll(db, false)).toHaveLength(1);
  });

  it("listEnabled returns only enabled", () => {
    TelegramConnectionRepo.create(db, "one", TOKEN, CHAT_ID);
    const c2 = TelegramConnectionRepo.create(db, "two", TOKEN, CHAT_ID);
    TelegramConnectionRepo.update(db, c2.id as string, { enabled: 0 });
    expect(TelegramConnectionRepo.listEnabled(db)).toHaveLength(1);
  });

  it("update changes fields and returns true", () => {
    const c = TelegramConnectionRepo.create(db, "old", TOKEN, CHAT_ID);
    const ok = TelegramConnectionRepo.update(db, c.id as string, {
      label: "new",
    });
    expect(ok).toBe(true);
    const row = TelegramConnectionRepo.get(db, c.id as string);
    expect(row!.label).toBe("new");
  });

  it("update returns false for missing id", () => {
    const ok = TelegramConnectionRepo.update(db, "nope", { label: "x" });
    expect(ok).toBe(false);
  });

  it("update returns false for empty fields", () => {
    const c = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    const ok = TelegramConnectionRepo.update(db, c.id as string, {});
    expect(ok).toBe(false);
  });

  it("delete removes a connection and returns true", () => {
    const c = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    expect(TelegramConnectionRepo.delete(db, c.id as string)).toBe(true);
    expect(TelegramConnectionRepo.get(db, c.id as string)).toBeUndefined();
  });

  it("delete returns false for missing id", () => {
    expect(TelegramConnectionRepo.delete(db, "nope")).toBe(false);
  });

  it("updateTestResult sets last_tested_at on success", () => {
    const c = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    TelegramConnectionRepo.updateTestResult(db, c.id as string, true);
    const row = TelegramConnectionRepo.get(db, c.id as string);
    expect(row!.last_tested_at).toBeDefined();
    expect(row!.last_test_error).toBeNull();
  });

  it("updateTestResult sets error on failure", () => {
    const c = TelegramConnectionRepo.create(db, "test", TOKEN, CHAT_ID);
    TelegramConnectionRepo.updateTestResult(
      db,
      c.id as string,
      false,
      "timeout",
    );
    const row = TelegramConnectionRepo.get(db, c.id as string);
    expect(row!.last_tested_at).toBeDefined();
    expect(row!.last_test_error).toBe("timeout");
  });

  it("create with enabled false", () => {
    const c = TelegramConnectionRepo.create(
      db,
      "disabled",
      TOKEN,
      CHAT_ID,
      false,
    );
    expect(c.enabled).toBe(0);
  });
});

// ── AlertRepo ──

describe("AlertRepo", () => {
  it("create returns a row with fields", () => {
    const row = AlertRepo.create(
      db,
      "BTC-USD",
      "price",
      '{"direction":"above","threshold":"100000"}',
    );
    expect(row.id).toBeDefined();
    expect(row.pair).toBe("BTC-USD");
    expect(row.alert_type).toBe("price");
    expect(row.config_json).toBe(
      '{"direction":"above","threshold":"100000"}',
    );
    expect(row.enabled).toBe(1);
    expect(row.triggered).toBe(0);
  });

  it("create with custom poll_interval_sec", () => {
    const row = AlertRepo.create(db, "ETH-USD", "rsi", null, 30);
    expect(row.poll_interval_sec).toBe(30);
  });

  it("create with connections_json", () => {
    const row = AlertRepo.create(
      db,
      "BTC-USD",
      "price",
      "{}",
      10,
      '["conn1","conn2"]',
    );
    expect(row.connections_json).toBe('["conn1","conn2"]');
  });

  it("get returns a row by id", () => {
    const created = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const row = AlertRepo.get(db, created.id as string);
    expect(row).toBeDefined();
    expect(row!.id).toBe(created.id);
  });

  it("get returns undefined for missing id", () => {
    expect(AlertRepo.get(db, "nonexistent")).toBeUndefined();
  });

  it("listAll returns all alerts", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(AlertRepo.listAll(db)).toHaveLength(2);
  });

  it("listAll filters by enabled", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    const a2 = AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    AlertRepo.update(db, a2.id as string, { enabled: 0 });
    expect(AlertRepo.listAll(db, { enabled: true })).toHaveLength(1);
    expect(AlertRepo.listAll(db, { enabled: false })).toHaveLength(1);
  });

  it("listAll filters by alert_type", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(
      AlertRepo.listAll(db, { alertType: "price" }),
    ).toHaveLength(1);
  });

  it("listAll filters by pair", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(AlertRepo.listAll(db, { pair: "BTC-USD" })).toHaveLength(1);
  });

  it("listAll supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      AlertRepo.create(db, "BTC-USD", "price", "{}");
    }
    expect(AlertRepo.listAll(db, { limit: 2 })).toHaveLength(2);
    expect(AlertRepo.listAll(db, { limit: 2, offset: 3 })).toHaveLength(
      2,
    );
  });

  it("listEnabled returns only enabled alerts", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    const a2 = AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    AlertRepo.update(db, a2.id as string, { enabled: 0 });
    expect(AlertRepo.listEnabled(db)).toHaveLength(1);
  });

  it("count returns total count", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(AlertRepo.count(db)).toBe(2);
  });

  it("count filters by enabled", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    const a2 = AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    AlertRepo.update(db, a2.id as string, { enabled: 0 });
    expect(AlertRepo.count(db, { enabled: true })).toBe(1);
  });

  it("count filters by alert_type", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(AlertRepo.count(db, { alertType: "rsi" })).toBe(1);
  });

  it("count filters by pair", () => {
    AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.create(db, "ETH-USD", "rsi", "{}");
    expect(AlertRepo.count(db, { pair: "ETH-USD" })).toBe(1);
  });

  it("update changes fields and returns true", () => {
    const a = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const ok = AlertRepo.update(db, a.id as string, { enabled: 0 });
    expect(ok).toBe(true);
    const row = AlertRepo.get(db, a.id as string);
    expect(row!.enabled).toBe(0);
  });

  it("update returns false for missing id", () => {
    expect(AlertRepo.update(db, "nope", { enabled: 0 })).toBe(false);
  });

  it("update returns false for empty fields", () => {
    const a = AlertRepo.create(db, "BTC-USD", "price", "{}");
    expect(AlertRepo.update(db, a.id as string, {})).toBe(false);
  });

  it("update sets triggered flag", () => {
    const a = AlertRepo.create(db, "BTC-USD", "price", "{}");
    AlertRepo.update(db, a.id as string, { triggered: 1 });
    const row = AlertRepo.get(db, a.id as string);
    expect(row!.triggered).toBe(1);
  });

  it("update sets current_value_json", () => {
    const a = AlertRepo.create(db, "BTC-USD", "price", "{}");
    const cv = JSON.stringify({ label: "Price", value: "50000" });
    AlertRepo.update(db, a.id as string, { current_value_json: cv });
    const row = AlertRepo.get(db, a.id as string);
    expect(row!.current_value_json).toBe(cv);
  });

  it("delete removes an alert", () => {
    const a = AlertRepo.create(db, "BTC-USD", "price", "{}");
    expect(AlertRepo.delete(db, a.id as string)).toBe(true);
    expect(AlertRepo.get(db, a.id as string)).toBeUndefined();
  });

  it("delete returns false for missing id", () => {
    expect(AlertRepo.delete(db, "nope")).toBe(false);
  });
});

// ── EventRepo ──

describe("EventRepo", () => {
  it("append creates an event and returns id", () => {
    const id = EventRepo.append(db, "test_event", { key: "value" });
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  it("append without details", () => {
    const id = EventRepo.append(db, "bare_event");
    const events = EventRepo.listRecent(db);
    const event = events.find((e) => e.id === id);
    expect(event).toBeDefined();
    expect(event!.details_json).toBeNull();
  });

  it("listRecent returns events in DESC order", () => {
    // Insert with explicit timestamps to ensure ordering
    db.prepare(
      "INSERT INTO events (id, ts, category, details_json) VALUES (?, ?, ?, ?)",
    ).run("e1", "2025-01-01T00:00:01Z", "first", null);
    db.prepare(
      "INSERT INTO events (id, ts, category, details_json) VALUES (?, ?, ?, ?)",
    ).run("e2", "2025-01-01T00:00:02Z", "second", null);
    const events = EventRepo.listRecent(db);
    expect(events).toHaveLength(2);
    expect(events[0].category).toBe("second");
    expect(events[1].category).toBe("first");
  });

  it("listRecent filters by category", () => {
    EventRepo.append(db, "alert_triggered", {});
    EventRepo.append(db, "worker_started", {});
    const events = EventRepo.listRecent(db, {
      category: "alert_triggered",
    });
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("alert_triggered");
  });

  it("listRecent supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      EventRepo.append(db, "event", { i });
    }
    expect(EventRepo.listRecent(db, { limit: 2 })).toHaveLength(2);
    expect(
      EventRepo.listRecent(db, { limit: 2, offset: 3 }),
    ).toHaveLength(2);
  });

  it("count returns total events", () => {
    EventRepo.append(db, "a", {});
    EventRepo.append(db, "b", {});
    expect(EventRepo.count(db)).toBe(2);
  });

  it("count filters by category", () => {
    EventRepo.append(db, "a", {});
    EventRepo.append(db, "b", {});
    expect(EventRepo.count(db, "a")).toBe(1);
  });
});

// ── HeartbeatRepo ──

describe("HeartbeatRepo", () => {
  it("get returns undefined when no heartbeat", () => {
    expect(HeartbeatRepo.get(db)).toBeUndefined();
  });

  it("upsert creates a heartbeat", () => {
    HeartbeatRepo.upsert(db, "running");
    const hb = HeartbeatRepo.get(db);
    expect(hb).toBeDefined();
    expect(hb!.status).toBe("running");
    expect(hb!.worker_id).toBe("main");
  });

  it("upsert updates existing heartbeat", () => {
    HeartbeatRepo.upsert(db, "running");
    HeartbeatRepo.upsert(db, "error", "something broke");
    const hb = HeartbeatRepo.get(db);
    expect(hb!.status).toBe("error");
    expect(hb!.last_error).toBe("something broke");
  });

  it("upsert with last_tick_ts", () => {
    HeartbeatRepo.upsert(db, "running", undefined, "2025-01-01T00:00:00Z");
    const hb = HeartbeatRepo.get(db);
    expect(hb!.last_tick_ts).toBe("2025-01-01T00:00:00Z");
  });

  it("isFresh returns false when no heartbeat", () => {
    expect(HeartbeatRepo.isFresh(db)).toBe(false);
  });

  it("isFresh returns true for recent heartbeat", () => {
    HeartbeatRepo.upsert(db, "running");
    expect(HeartbeatRepo.isFresh(db)).toBe(true);
  });

  it("isFresh returns false for stale heartbeat", () => {
    HeartbeatRepo.upsert(db, "running");
    // Manually set old timestamp
    db.prepare(
      "UPDATE worker_heartbeat SET ts = '2020-01-01T00:00:00Z' WHERE worker_id = ?",
    ).run("main");
    expect(HeartbeatRepo.isFresh(db)).toBe(false);
  });
});
