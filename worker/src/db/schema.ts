import type Database from "better-sqlite3";

type MigrationFn = (db: Database.Database) => void;

interface Migration {
  version: number;
  description: string;
  up: MigrationFn;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Create initial tables",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telegram_connections (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          bot_token TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_tested_at TEXT,
          last_test_error TEXT
        );

        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY,
          pair TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
          threshold TEXT NOT NULL,
          poll_interval_sec INTEGER NOT NULL DEFAULT 10,
          enabled INTEGER NOT NULL DEFAULT 1,
          connections_json TEXT,
          last_checked_at TEXT,
          last_triggered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          category TEXT NOT NULL,
          details_json TEXT
        );

        CREATE TABLE IF NOT EXISTS worker_heartbeat (
          worker_id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          pid INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          last_error TEXT,
          last_tick_ts TEXT,
          version TEXT
        );
      `);
    },
  },
  {
    version: 2,
    description: "Add triggered state to alerts",
    up(db) {
      db.exec("ALTER TABLE alerts ADD COLUMN triggered INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 3,
    description: "Add alert_type and config_json columns",
    up(db) {
      db.exec(
        "ALTER TABLE alerts ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'price'",
      );
      db.exec("ALTER TABLE alerts ADD COLUMN config_json TEXT");
    },
  },
  {
    version: 4,
    description: "Remove legacy columns, add current_value_json",
    up(db) {
      db.exec("ALTER TABLE alerts DROP COLUMN direction");
      db.exec("ALTER TABLE alerts DROP COLUMN threshold");
      db.exec("ALTER TABLE alerts ADD COLUMN current_value_json TEXT");
    },
  },
];

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);

  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    if (m.version > current) {
      m.up(db);
      db.prepare(
        "INSERT INTO schema_version (version, description) VALUES (?, ?)",
      ).run(m.version, m.description);
    }
  }
}
