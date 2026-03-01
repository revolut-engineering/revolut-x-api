import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { getConfigDir } from "../shared/settings.js";

export function getDbPath(): string {
  return join(getConfigDir(), "revolutx.db");
}

export function createDatabase(path?: string): Database.Database {
  const dbPath = path ?? getDbPath();

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (dbPath !== ":memory:" && platform() !== "win32") {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // silently ignore permission errors
    }
  }

  return db;
}
