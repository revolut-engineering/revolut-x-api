import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newId(): string {
  return randomUUID();
}

// ── Telegram Connections ──

export class TelegramConnectionRepo {
  static create(
    db: Database.Database,
    label: string,
    botToken: string,
    chatId: string,
    enabled = true,
  ): Record<string, unknown> {
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO telegram_connections
       (id, label, bot_token, chat_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, label, botToken, chatId, enabled ? 1 : 0, now, now);
    return db
      .prepare("SELECT * FROM telegram_connections WHERE id = ?")
      .get(id) as Record<string, unknown>;
  }

  static get(
    db: Database.Database,
    connectionId: string,
  ): Record<string, unknown> | undefined {
    return db
      .prepare("SELECT * FROM telegram_connections WHERE id = ?")
      .get(connectionId) as Record<string, unknown> | undefined;
  }

  static listAll(
    db: Database.Database,
    enabled?: boolean,
  ): Record<string, unknown>[] {
    if (enabled === undefined) {
      return db
        .prepare(
          "SELECT * FROM telegram_connections ORDER BY created_at",
        )
        .all() as Record<string, unknown>[];
    }
    return db
      .prepare(
        "SELECT * FROM telegram_connections WHERE enabled = ? ORDER BY created_at",
      )
      .all(enabled ? 1 : 0) as Record<string, unknown>[];
  }

  static listEnabled(db: Database.Database): Record<string, unknown>[] {
    return db
      .prepare(
        "SELECT * FROM telegram_connections WHERE enabled = 1 ORDER BY created_at",
      )
      .all() as Record<string, unknown>[];
  }

  static update(
    db: Database.Database,
    connectionId: string,
    fields: Record<string, unknown>,
  ): boolean {
    if (Object.keys(fields).length === 0) return false;
    const f = { ...fields, updated_at: nowIso() };
    const setClause = Object.keys(f)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = [...Object.values(f), connectionId];
    const result = db
      .prepare(
        `UPDATE telegram_connections SET ${setClause} WHERE id = ?`,
      )
      .run(...values);
    return result.changes > 0;
  }

  static delete(db: Database.Database, connectionId: string): boolean {
    const result = db
      .prepare("DELETE FROM telegram_connections WHERE id = ?")
      .run(connectionId);
    return result.changes > 0;
  }

  static updateTestResult(
    db: Database.Database,
    connectionId: string,
    success: boolean,
    error?: string,
  ): void {
    const now = nowIso();
    db.prepare(
      `UPDATE telegram_connections
       SET last_tested_at = ?, last_test_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, success ? null : (error ?? null), now, connectionId);
  }
}

// ── Alerts ──

export class AlertRepo {
  static create(
    db: Database.Database,
    pair: string,
    alertType: string,
    configJson?: string,
    pollIntervalSec = 10,
    connectionsJson?: string,
  ): Record<string, unknown> {
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO alerts
       (id, pair, poll_interval_sec, enabled,
        connections_json, alert_type, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      pair,
      pollIntervalSec,
      connectionsJson ?? null,
      alertType,
      configJson ?? null,
      now,
      now,
    );
    return db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
  }

  static get(
    db: Database.Database,
    alertId: string,
  ): Record<string, unknown> | undefined {
    return db.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId) as
      | Record<string, unknown>
      | undefined;
  }

  static listAll(
    db: Database.Database,
    opts: {
      enabled?: boolean;
      alertType?: string;
      pair?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Record<string, unknown>[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts.alertType !== undefined) {
      conditions.push("alert_type = ?");
      params.push(opts.alertType);
    }
    if (opts.pair !== undefined) {
      conditions.push("pair = ?");
      params.push(opts.pair);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    params.push(limit, offset);

    return db
      .prepare(
        `SELECT * FROM alerts ${where} ORDER BY created_at LIMIT ? OFFSET ?`,
      )
      .all(...params) as Record<string, unknown>[];
  }

  static listEnabled(db: Database.Database): Record<string, unknown>[] {
    return db
      .prepare("SELECT * FROM alerts WHERE enabled = 1 ORDER BY created_at")
      .all() as Record<string, unknown>[];
  }

  static count(
    db: Database.Database,
    opts: {
      enabled?: boolean;
      alertType?: string;
      pair?: string;
    } = {},
  ): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts.alertType !== undefined) {
      conditions.push("alert_type = ?");
      params.push(opts.alertType);
    }
    if (opts.pair !== undefined) {
      conditions.push("pair = ?");
      params.push(opts.pair);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM alerts ${where}`)
      .get(...params) as { c: number };
    return row.c;
  }

  static update(
    db: Database.Database,
    alertId: string,
    fields: Record<string, unknown>,
  ): boolean {
    if (Object.keys(fields).length === 0) return false;
    const f = { ...fields, updated_at: nowIso() };
    const setClause = Object.keys(f)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = [...Object.values(f), alertId];
    const result = db
      .prepare(`UPDATE alerts SET ${setClause} WHERE id = ?`)
      .run(...values);
    return result.changes > 0;
  }

  static delete(db: Database.Database, alertId: string): boolean {
    const result = db
      .prepare("DELETE FROM alerts WHERE id = ?")
      .run(alertId);
    return result.changes > 0;
  }
}

// ── Events ──

export class EventRepo {
  static append(
    db: Database.Database,
    category: string,
    details?: Record<string, unknown>,
  ): string {
    const id = newId();
    db.prepare(
      "INSERT INTO events (id, ts, category, details_json) VALUES (?, ?, ?, ?)",
    ).run(id, nowIso(), category, details ? JSON.stringify(details) : null);
    return id;
  }

  static listRecent(
    db: Database.Database,
    opts: { category?: string; limit?: number; offset?: number } = {},
  ): Record<string, unknown>[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    if (opts.category !== undefined) {
      return db
        .prepare(
          "SELECT * FROM events WHERE category = ? ORDER BY ts DESC LIMIT ? OFFSET ?",
        )
        .all(opts.category, limit, offset) as Record<string, unknown>[];
    }
    return db
      .prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
  }

  static count(
    db: Database.Database,
    category?: string,
  ): number {
    if (category !== undefined) {
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE category = ?")
        .get(category) as { c: number };
      return row.c;
    }
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM events")
      .get() as { c: number };
    return row.c;
  }
}

// ── Worker Heartbeat ──

export class HeartbeatRepo {
  static readonly WORKER_ID = "main";

  static upsert(
    db: Database.Database,
    status = "running",
    lastError?: string,
    lastTickTs?: string,
  ): void {
    const now = nowIso();
    db.prepare(
      `INSERT INTO worker_heartbeat
       (worker_id, ts, status, last_error, last_tick_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(worker_id) DO UPDATE SET
       ts = excluded.ts, status = excluded.status,
       last_error = excluded.last_error, last_tick_ts = excluded.last_tick_ts`,
    ).run(HeartbeatRepo.WORKER_ID, now, status, lastError ?? null, lastTickTs ?? null);
  }

  static get(
    db: Database.Database,
  ): Record<string, unknown> | undefined {
    return db
      .prepare(
        "SELECT * FROM worker_heartbeat WHERE worker_id = ?",
      )
      .get(HeartbeatRepo.WORKER_ID) as Record<string, unknown> | undefined;
  }

  static isFresh(
    db: Database.Database,
    maxAgeSec = 30,
  ): boolean {
    const hb = HeartbeatRepo.get(db);
    if (!hb) return false;
    try {
      const ts = new Date(hb.ts as string);
      const age = (Date.now() - ts.getTime()) / 1000;
      return age <= maxAgeSec;
    } catch {
      return false;
    }
  }
}
